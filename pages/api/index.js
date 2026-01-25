import { ERROR_MESSAGES } from '../../lib/errors.js';
import { getUserFromRequest } from '../../lib/supabaseServer.js';
import { api } from '../../lib/api.js';
import { supabaseAdmin } from '../../lib/supabaseServer.js';
import { jobSchema, jobUpdateSchema } from '../../lib/validations/jobSchema.js';



export async function HandleRequests(req,res){
    const user = getUserFromRequest(req)

    if(!user){
        return { user: null, message : ERROR_MESSAGES.UNAUTHORIZED}
    }

    switch ( req.method ){
        case 'GET':
            const { data, error } = await supabaseAdmin.from('jobs').select()
            return res.status(200).json({data})
        break;
        case 'POST':
            const createResult = jobSchema.safeParse(req.body)

            if(!createResult.success){
                return { error: createResult.error, message : ERROR_MESSAGES.FETCH_FAILED }
            }else{
                const resultData = createResult.data
                const { data, error } = await supabaseAdmin.from('jobs').insert({resultData})
                if(error){
                return { error : ERROR_MESSAGES.ADD_FAILED, message: "Failed to add job data"}
            }}
        break;
        case 'PUT':
            res = await api.put('/')
        break;
        
    }

}
