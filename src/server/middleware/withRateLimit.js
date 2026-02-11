import { getUserFromRequest } from '../lib/supabaseServer.js';
import { checkRateLimit } from '../lib/rateLimit.js';
import { METHOD_TO_OPERATIONS, TIERS } from '../../shared/constants/tiers.js';
import { ERROR_MESSAGES } from '../../shared/errors.js';
import { sendError } from '../../shared/response.js';
import { logger } from '../../shared/logger.js';



function normalizeIp(ip){
    if(ip.startsWith('::ffff:')){
        return ip.slice(7)
    }
    return ip
}


/**
 * Extracts the rate limit identifier from req
 * 
 * Use 'user:{id}' for auth users, 'ip:{address}' for others
 * 
 * @param {import('next').NextApiRequest} req - Next.js API req
 * @returns {Promise<string>} Identifier string 
 */




async function extractIdentifier(req){
    try{
        const { user } = await getUserFromRequest(req)
        if(user?.id){
            return `user:${user.id}`
        }
    }catch(error){
        logger.debug('Auth extraction failed for rate limiting. Falling back to IP',{
            error: error.message
        })
    }


    //Ip based fallback. Reads the vercel real ip HTTP header, then extracts IP
    const ip = req.headers['x-real-ip'] || req.socket?.remoteAddress || 'anonymous';


    return `ip:${normalizeIp(ip)}`

}


/**
 * Set rate limit headers on the res obj
 * 
 * @param {import('next').NextApiResponse} res - Next.js res obj
 * @param {object} rateLimitResult - result from checkRateLimit
 */

function setRateLimitHeaders(res, rateLimitResult){
    if(rateLimitResult.limit !== null && rateLimitResult.limit !== undefined){
        res.setHeader('X-RateLimit-Limit', rateLimitResult.limit)
    }
    if(rateLimitResult.remaining !== null && rateLimitResult.remaining !== undefined){
        res.setHeader('X-RateLimit-Remaining', rateLimitResult.remaining)
    }
    if(rateLimitResult.reset){
        res.setHeader('X-RateLimit-Reset', rateLimitResult.reset)
    }
    if(rateLimitResult.window){
        res.setHeader('X-RateLimit-Window', rateLimitResult.window)
    }
}

/**
 * Rate limiting middleware wrapper for Next.js API handlers
 *
 * Applies per-user or per-IP rate limiting before handler execution
 * Connects to:
 * - extractIdentifier() for user/IP identity
 * - checkRateLimit() from rateLimit.js for limit evaluation
 * - METHOD_TO_OPERATIONS from tiers.js for HTTP method mapping
 * - sendError() from response.js for 429 responses
 *
 *
 * @param {Function} handler - Next.js API handler (req, res) => Promise
 * @returns {Function} Wrapped handler with rate limiting applied
 */

export function withRateLimit(handler){
    return async(req, res) => {
        const operation = METHOD_TO_OPERATIONS[req.method]

        //unmapped methods skip rate limits 
        if(!operation){
            return handler(req,res)
        }

        let rateLimitResult

        try {
            const identifier = await extractIdentifier(req)

            const tier = TIERS.FREE

            rateLimitResult = await checkRateLimit(identifier, tier, operation)
        }catch(error){
            logger.error('Rate limit check threw unexpected error', {
                error: error.message,
                stack: error.stack,
                method: req.method,
                operation
            })

        return sendError(
            res,
            503,
            ERROR_MESSAGES.SERVICE_UNAVAILABLE,
            ERROR_MESSAGES.SERVICE_UNAVAILABLE
            )}


        // block req on redis down
        if(rateLimitResult.unavailable){
            logger.warn('Rate limiting unavaliable, req denied', {
                operation,
                method: req.method
            })
            return sendError(
                res,
                503,
                ERROR_MESSAGES.SERVICE_UNAVAILABLE,
                ERROR_MESSAGES.SERVICE_UNAVAILABLE
            )
        }
        // set limit headers on all res
        setRateLimitHeaders(res, rateLimitResult)

        // rate limit exceeded 
        if(!rateLimitResult.success){
            const retryAfterSeconds = rateLimitResult.reset 
            ? Math.max(0, Math.ceil((rateLimitResult.reset - Date.now()) / 1000)) : 60

            res.setHeader('Retry-After', retryAfterSeconds)

            logger.warn('Rate Limit exceeded', {
                operation,
                window: rateLimitResult.window,
                limit: rateLimitResult.limit,
                retryAfterSeconds
            })

            return sendError(
                res,
                429,
                ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
                ERROR_MESSAGES.RATE_LIMIT_EXCEEDED
            )
        }

        return handler(req,res)
    }

}