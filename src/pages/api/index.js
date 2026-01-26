import { ERROR_MESSAGES } from '../../shared/errors.js';
import { getUserFromRequest, supabaseAdmin } from '../../server/lib/supabaseServer.js';
import { jobSchema, jobUpdateSchema } from '../../shared/validations/jobSchema.js';



export async function HandleRequests(req,res){

    let user = null

    try{
        user = getUserFromRequest(req)

        if(!user){
        return res.status(400).json({ user: null, message : ERROR_MESSAGES.UNAUTHORIZED})
        }

    }catch(error){
        return res.status(400).json({ user: null, message : ERROR_MESSAGES.UNAUTHORIZED})
    }

    switch ( req.method ){

        case 'GET':{
            const { data, error } = await supabaseAdmin.from('jobs').select().eq('user_id', user.Id).order('created')
            if(error){
                return res.status(503).json({ error : ERROR_MESSAGES.FETCH_FAILED, message: "Server unavaliable"})
            }
            return res.status(200).json({data})
        }
        case 'POST':{
            const createResult = jobSchema.safeParse(req.body)

            if(!createResult.success){
                return res.status(400).json({ data: null, error: createResult.error, message : ERROR_MESSAGES.FETCH_FAILED })
            }
            
            const finalizedData = createResult.data
            const { data, error } = await supabaseAdmin.from('jobs').insert({ ...finalizedData, user_id : user.Id})

            if(error){
                return res.status(400).json({ data: null, error : ERROR_MESSAGES.ADD_FAILED, message: "Failed to add job data"})}
                    
            return res.status(201).json({ data, message: "Successfully added job"})
        }
            

        case 'PUT':{
            const { id, ...bodyWithoutId } = req.body
            if(!id){
                return res.status(400).json({error : ERROR_MESSAGES.NOT_FOUND, message : "ID not found"})
            }
            const updateResult = jobUpdateSchema.safeParse(bodyWithoutId)

            if(!updateResult.success){
                return res.status(400).json({ error : ERROR_MESSAGES.UPDATE_FAILED, message : "Update Failed"})
            }

            const updatedData = updateResult.data
            const { data, error } = await supabaseAdmin.from('jobs').update({ ...updatedData, user_id : user.Id}).eq('id', id).eq("user_id", user.Id).select("*")

            if(error){
                return res.status(400).json({ data : null, error : ERROR_MESSAGES.ADD_FAILED, message : "Failed to update job data"})
            }

            return res.status(200).json({data, message : "Successfully updated job details"})

        }

        default:
            return res.status(405).json({
            error: ERROR_MESSAGES.METHOD_NOT_ALLOWED,
            message: "Method not allowed"
  })

        
    }

}
