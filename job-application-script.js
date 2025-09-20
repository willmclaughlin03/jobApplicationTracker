
// Things needed in js to process the addition and display of job:

// Job input needs to be collected
// job input needs to be saved in local storage
// job input needs to be displayed

// job input needs to be able to be edited AFTER it is displayed
// job input needs to be saved again in local storage
// job input needs to be displayed

let editIndex = null;


function displayJobInfo(){
    document.getElementById("job-board-save-button").addEventListener("click", afterPressDiplayJobs);

}

function displayFilterResults(){
    document.getElementById("filter").addEventListener("click", filterJobs)
}

function renderJobs(){
    // rebuilds the pages
    let jobArray = JSON.parse(localStorage.getItem("jobArray")) || [];
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
    const company = document.getElementById("company").value
    const position = document.getElementById("position").value
    const status = document.getElementById("status").value
    const notes = document.getElementById("notes").value

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
    let filterEntry = document.getElementById("filter").value.toLowerCase();
    let filterSelect = document.getElementById("status-search").value;
    let jobArray = JSON.parse(localStorage.getItem("jobArray")) || [];

    let filteredJobs = jobArray.filter(job => {
        let matchEntry = filterEntry === "" ||
        job.company.toLowerCase().includes(filterEntry) ||
        job.position.toLowerCase().includes(filterEntry);

        let matchStatus = filterSelect === "none" || job.status === filterSelect;
        return matchEntry && matchStatus;
    
    })
    
    // if(filterEntry !== ""){
    //     filteredJobs = jobArray.filter(job =>
    //         job.company.includes(filterEntry) || job.position.includes(filterEntry));
    //         renderJobs(filteredJobs);
    // }
    // if(filterSelect !== "none"){
    //     filteredJobs = jobArray.filter(job =>
    //         job.status === filterSelect
    //     );
    //     renderJobs(filteredJobs);
    // }
    if(filteredJobs.length === 0){
        alert("No Results found");
        // renderJobs();
    }
    renderJobs(filteredJobs);
}

renderJobs();
