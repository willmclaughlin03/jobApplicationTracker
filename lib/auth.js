import { supabase } from "./supabase.js"

export const signUp = async (email, password) => {
    const { data, error } = await supabase.auth.signUp({
        email,
        password
    });
    return { data, error }
}

export const signIn = async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password
    })
    return {data, error}
}

export const signOut = async () => {
    const {error} = await supabase.auth.signOut();
    return {error};
}

export const getCurrentUser = async () => {
    const { data : {user} } = await supabase.auth.getUser();
    return user;
}