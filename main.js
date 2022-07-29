const fs = require('fs');
const fse = require('fs-extra');
const path = require('path');
const Apify = require('apify');
const execSync = require('child_process').execSync;
var parse = require('csv-parse/lib/sync');

let apifyClient;
const ACTOR_DIRECTORY = path.join(__dirname, "repositories/actors");
const TEMPLATE_DIRECTORY = path.join(__dirname, "repositories/template");
const SHELL_OPTIONS = { encoding: 'utf-8', shell: "/bin/bash", cwd: ACTOR_DIRECTORY };

function executeGitCommand(command) {
    const output = execSync(command, SHELL_OPTIONS);
    //console.log(output);
}

function replaceInFile(actorPath, filePath, replacePairs) {
    const actorMainPath = path.join(actorPath, filePath);
    let fileContent = fs.readFileSync(actorMainPath, {encoding:'utf8', flag:'r'});
    for(let replacePair of replacePairs) {
        fileContent = fileContent.replace(
            replacePair.searchValue,
            replacePair.replaceValue
        );
    }
    fs.writeFileSync(actorMainPath, fileContent);
}

async function copyTemplateAndCustomize(extractedInput, actorTitle, websiteName, websiteUrl, startUrls) {
    const actorName = actorTitle.toLowerCase().replace(/\s/g, "-");
    const actorPath = path.join(ACTOR_DIRECTORY, actorName);

    //copy directory content including subfolders
    fse.copySync(TEMPLATE_DIRECTORY, actorPath);

    replaceInFile(actorPath, "main.js", [{
        searchValue: "INPUT_TOKEN_TO_REPLACE",
        replaceValue: `...JSON.parse("${JSON.stringify(extractedInput).replace(/"/g, "\\\"").replace(/\\n/g, "\\\\n")}".replace(/\\\\\"/g,"\\\"")),`
    }])

    replaceInFile(actorPath, "README.md",
        [
            {
                searchValue: /\[TARGET WEBSITE NAME\]/g,
                replaceValue: websiteName
            },
            {
                searchValue: /\[TARGET WEBSITE URL\]/g,
                replaceValue: websiteUrl
            }
        ]
    )

    replaceInFile(actorPath, "INPUT_SCHEMA.json", [{
        searchValue: /\[START URLS\]/g,
        replaceValue: JSON.stringify(startUrls)
    }])

    replaceInFile(actorPath, ".actor/actor.json",
        [
            {
                searchValue: /\[TARGET WEBSITE URL\]/g,
                replaceValue: websiteUrl
            },
            {
                searchValue: /\[ACTOR NAME\]/g,
                replaceValue: actorName
            },
            {
                searchValue: /\[ACTOR TITLE\]/g,
                replaceValue: actorTitle
            }
        ]
    )

    return actorName;
}

async function uploadToGithub(actorName, actorFolderName) {
    executeGitCommand(`git add '${actorFolderName}'`);
    executeGitCommand(`git commit -m "Commiting ${actorName}"`);
    executeGitCommand('git push origin master');

    return `https://github.com/Equidem/news-actor-creator.git#master:actors/${actorFolderName}`;
}

async function createApifyActor(name, title, githubUrl, startUrls) {
    const actorInfo = await apifyClient.actors().create({
        name: name,
        description: "",
        isPublic: true,
        categories: [ "NEWS" ],
        title: title,
        pictureUrl: 'https://raw.githubusercontent.com/Equidem/news-actor-creator/master/pngtree-vector-newspaper-icon-png-image_1577280.jpg',
        versions: [{
            versionNumber: "1.0",
            sourceType: "GIT_REPO",
            gitRepoUrl: githubUrl,
            envVars: [],
            baseDockerImage: "apify/actor-node-basic",
            applyEnvVarsToBuild: false,
            buildTag: "latest"
        }],
        defaultRunOptions: {
            build: "latest",
            timeoutSecs: 1800,
            memoryMbytes: 4096
        }
    });

    const actorClient = apifyClient.actor(actorInfo['id']);

    console.log("Building actor");

    await actorClient.build("1.0", {
        waitForFinish: 10000
    });

    console.log('Running actor');
    let actorRun = await actorClient.call(
        {
            startUrls,
            maxArticlesPerCrawl: 100
        }
    );

    let results = (await apifyClient.dataset(actorRun.defaultDatasetId).get()).cleanItemCount;
    console.log(results);

    //console.log(actorRun);

    console.log("Run finished");

    return {
        actorId: actorInfo['id'],
        results
    };
}

async function extractTaskInformation(taskUrl) {
    //console.log(taskUrl);
    let id = taskUrl.match(/tasks\/(\w+)[\/#]?/)[1];
    let taskInfo = await apifyClient.task(id).get();

    let owner = taskInfo["userId"];
    let input = taskInfo["input"];

    return {
        id,
        owner,
        input
    }
}

function formActorUrl(actorId, owner) {
    return `https://console.apify.com/admin/users/${owner}/actors/${actorId}`;
}

async function processTask(taskUrl, websiteName, websiteUrl) {
    const scraperTitle = websiteName + " Scraper"
    const { id, owner, input} = await extractTaskInformation(taskUrl);
    /*
    console.log('Task:');
    console.log(id);
    console.log(owner);
    console.log(input);
    console.log('................\n\n');
    */

    const startUrls = input['startUrls'];
    const actorFolderName = await copyTemplateAndCustomize(input, scraperTitle, websiteName, websiteUrl, startUrls);
    const githubUrl = await uploadToGithub(scraperTitle, actorFolderName);
    const { actorId, results } = await createApifyActor(actorFolderName, scraperTitle, githubUrl, startUrls);
    return {
        actorUrl: formActorUrl(actorId, owner),
        results: results
    };
}

async function updateActor(actorUrl, websiteUrl) {
    let actorId = actorUrl.split("actors/")[1];
    console.log(actorId);
    if(actorId == "7Op5iRBmNqI7kywlp") {
        console.log("Already done this");
        return;
    }
    await apifyClient.actor(actorId).update({
        description: `Scrape news data from ${websiteUrl} with this unofficial API. ` +
            "Extract articles, monitor their popularity and performance and automate the fight against fake news. " +
            "Filter the results by authors, topics, categories, or publication dates. " +
            "Preview or download the results in your preferred format.",
        pricingInfos: [{
            pricingModel: 'FLAT_PRICE_PER_MONTH',
            pricePerUnitUsd: 20,
            apifyMarginPercentage: 0,
            trialMinutes: 10080
        }]
    });
}

Apify.main(async () => {
    const input = await Apify.getInput();
    console.log('Input:');
    console.dir(input);

    let fileContent = fs.readFileSync('task-data.csv', {encoding:'utf8', flag:'r'});
    let tasks = parse(fileContent, {columns: true});
    console.log(tasks)

    /*
    tasks = [
        {
            "task_url": "https://console.apify.com/actors/tasks/sxEWpTLGi89IhFX5f#console",
            "name": "CNBC",
            "url": "cnbc.com",
            "access_token": "ggBsxLgwEpidgxoqGuqm8oee4"
        }
    ];
    */

    // Make sure the actor directory exists
    if (!fs.existsSync(ACTOR_DIRECTORY)){
        fs.mkdirSync(ACTOR_DIRECTORY);
    }

    let count = 0;
    let fullResultsActors = [];
    let nonFullResultsActors = [];
    let startWorking = true;
    for(let task of tasks) {
        if(!startWorking && task['actor_url'] != "https://console.apify.com/admin/users/Zji7Rt6MKGCn6Ae6A/actors/cZppKfvStpxcCQE8g") {
            continue;
        }
        startWorking = true;
        apifyClient = Apify.newClient({ token: task["access_token"] });
        await updateActor(task['actor_url'], task['url']);
        console.log(`Done: ${task['actor_url']}`);
        /*
        const { actorUrl, results } = await processTask(task["task_url"], task["name"], task["url"]);
        console.log(`Fully generated actor URL: ${actorUrl}`);
        if(results == 100) {
            fullResultsActors.push(actorUrl);
        } else {
            nonFullResultsActors.push({
                "url": actorUrl,
                "results": results
            });
        }
        count++;
         */
    }

    /*
    console.log(`\n\n\nGenerated ${fullResultsActors.length} full results actors:`);
    console.log(fullResultsActors);

    console.log(`\n\n\nGenerated ${nonFullResultsActors.length} non-full results actors:`);
    console.log(nonFullResultsActors);
     */
});
