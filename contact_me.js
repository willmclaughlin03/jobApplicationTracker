async function submitContactMe(){
    const submissionEmail = document.getElementById("messageContact").value.trim();
    const submissionName = document.getElementById("messageName").value.trim();
    const submissionNote = document.getElementById("messageNote").value.trim();

    if(!submissionEmail || !submissionName || !submissionNote){
        alert("Please submit your email and name!");
        return;
    }

    const params = {
        from_name: submissionName,
        email: submissionEmail,
        message: submissionNote,
    };

    emailjs.send("service_wwbxbqb", "template_5ssnfjh", params)
    .then(() => {
        alert("Thank you for your submission");
        document.getElementById("messageContact").value = "";
        document.getElementById("messageName").value = "";
        document.getElementById("messageNote").value = "";
    })
    .catch((error) => {
        console.error("EmailJS error:", error);
        alert("Failed to send email. Please try again later!")
    })
}