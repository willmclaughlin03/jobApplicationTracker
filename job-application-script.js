let editIndex = null;


function renderJobs(filteredJobs){

    // rebuilds the pages
    
    let jobArray = filteredJobs || JSON.parse(localStorage.getItem("jobArray")) || [];

    const addToBoard = document.getElementById("job-display-board-list");
    addToBoard.innerHTML = "";

    jobArray.forEach((job, index) => {

        // this part of loop handles the rendering of jobs/ creation
        const liJob = document.createElement("li");
        liJob.innerHTML =  `
        <div id = "job-div">${job.company} - ${job.position} (${job.status}) (${job.notes})</div>
        <button data-index="${index}" class="editBtn">Edit</button>
        <button data-index="${index}" class="deleteBtn">Delete</button>`;


        liJob.classList.add('status-' + job.status);
        addToBoard.appendChild(liJob);


        // loads and handles edit values and btn
        liJob.querySelector(".editBtn").addEventListener("click", () => {
        document.getElementById("company").value = job.company;
        document.getElementById("position").value = job.position;
        document.getElementById("status").value = job.status;
        document.getElementById("notes").value = job.notes;
        editIndex = index;

    });
    liJob.querySelector(".deleteBtn").addEventListener("click", () => {
            let jobArray = JSON.parse(localStorage.getItem("jobArray")) || [];

            // deletes one item at that index
            jobArray.splice(index, 1); 

            localStorage.setItem("jobArray", JSON.stringify(jobArray));

            renderJobs();
        });
    });

}


function afterPressDiplayJobs(){
    // recieves the input
    const company = document.getElementById("company").value.trim()
    const position = document.getElementById("position").value.trim()
    const status = document.getElementById("status").value.trim()
    const notes = document.getElementById("notes").value.trim()

    if(!company || !position){
        alert("Please fill out both the company and position fields");
        return;
    }



    let jobArray = JSON.parse(localStorage.getItem("jobArray")) || [];



    if(editIndex !== null){
        jobArray[editIndex] = { company, position, status, notes};
        editIndex = null;
    }else{
        jobArray.push({company,position,status,notes});
    }

    localStorage.setItem("jobArray", JSON.stringify(jobArray));

    renderJobs();
}


function filterJobs(){
    let filterEntry = document.getElementById("filter").value.trim().toLowerCase();

     let jobArray = JSON.parse(localStorage.getItem("jobArray")) || [];
    
    let filteredJobs = jobArray.filter(job => {
        return job.company.toLowerCase().includes(filterEntry) || job.position.toLowerCase().includes(filterEntry);
    });
    

    if(filteredJobs.length === 0){
        alert("No Results found");
        renderJobs();
    }else{
    renderJobs(filteredJobs);
}
}



renderJobs();

