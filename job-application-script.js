let editIndex = null;

function renderJobs(filteredJobs){

    // // modal
    const modal = document.getElementById("editModal");
    const closeModal = document.getElementById("closeModal");
    const saveBtn = document.getElementById("saveEditBtn")

    // rebuilds the pages
    
    let jobArray = JSON.parse(localStorage.getItem("jobArray")) || [];

    let displayNewJobs = filteredJobs || jobArray

    const addToBoard = document.getElementById("job-display-board-list");
    addToBoard.innerHTML = "";

    displayNewJobs.forEach((job, index) => {

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
        document.getElementById("editCompany").value = job.company;
        document.getElementById("editPosition").value = job.position;
        document.getElementById("editStatus").value = job.status;
        document.getElementById("editNotes").value = job.notes;

        // responsible for full array index, not just filtered
        editIndex = jobArray.findIndex(j =>
            j.company === job.company &&
            j.position === job.position &&
            j.status === job.status &&
            j.notes === job.notes
        );
        
        modal.classList.add("show");
    });

    liJob.querySelector(".deleteBtn").addEventListener("click", () => {

            let userResponse = confirm("Are you sure you want to delete this?");

            if(userResponse === true){
            // Find the correct index in the full array
            let deleteIndex = jobArray.findIndex(j =>
                j.company === job.company &&
                j.position === job.position &&
                j.status === job.status &&
                j.notes === job.notes
            );
            
            jobArray.splice(deleteIndex, 1); 

            localStorage.setItem("jobArray", JSON.stringify(jobArray));

            renderJobs();
            }
        });
    });
}

// Fix to not being able to reset after saving modal edit
function setupModalListeners(){
    const modal = document.getElementById("editModal");
    const closeModal = document.getElementById("closeModal");
    const saveBtn = document.getElementById("saveEditBtn");

    saveBtn.addEventListener("click", () => {
        if(editIndex !== null){
            let jobArray = JSON.parse(localStorage.getItem("jobArray")) || [];
            
            jobArray[editIndex].company = document.getElementById("editCompany").value;
            jobArray[editIndex].position = document.getElementById("editPosition").value;
            jobArray[editIndex].status = document.getElementById("editStatus").value;
            jobArray[editIndex].notes = document.getElementById("editNotes").value;

            localStorage.setItem("jobArray", JSON.stringify(jobArray));
            modal.classList.remove("show");

            renderJobs();
            editIndex = null;
        }
    });

    closeModal.addEventListener("click", () =>{
        modal.classList.remove("show");
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
        return job.company.toLowerCase().includes(filterEntry) || job.position.toLowerCase().includes(filterEntry) || job.status.toLowerCase().includes(filterEntry);
    });
    

    if(filteredJobs.length === 0){
        alert("No Results found");
        renderJobs();
    }else{
        renderJobs(filteredJobs);
    }
}

function clearAll(){
    document.getElementById("company").value = '';
    document.getElementById("position").value = '';
    document.getElementById("status").value = '';
    document.getElementById("notes").value = '';
}

function clearReset(){
    document.getElementById("filter").value = '';
}



setupModalListeners();
renderJobs();