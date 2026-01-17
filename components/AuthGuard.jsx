import { useEffect, useState } from "react";
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabase.js'

export default function AuthGuard({ children }) {
    const [loading, setLoading] = useState(true)
    const router = useRouter();


    useEffect(() => {
        const checkUser = async() => {
            const {data : { session } }= await supabase.auth.getSession();
            if (!session){
                router.push('/login')
            }
            setLoading(false)
        }
        checkUser();
    }, []);

    if (loading) return <div>Loading...</div>
    return children
}