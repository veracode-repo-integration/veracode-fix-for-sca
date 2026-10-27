const core = require('@actions/core');
const github = require('@actions/github');
const {DefaultArtifactClient} = require('@actions/artifact')
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const workspaceDir = process.env.GITHUB_WORKSPACE;

async function post() {
    let artifactFiles = [];

    const reportFilename = 'sca-fix-report.md';
    const artifactFilePath = path.join(workspaceDir, 'source-code', reportFilename);
    if (fs.existsSync(artifactFilePath)) {
        artifactFiles.push(artifactFilePath);
    } else {
      core.info(`${reportFilename} not found. Not included in artifact list.`);
    }

    const statusFilename = 'sca-fix-status';
    const statusFilePath = path.join(workspaceDir, 'source-code', statusFilename);
    if (fs.existsSync(statusFilePath)) {
        artifactFiles.push(statusFilePath);
    } else {
        core.info(`${statusFilename} not found. Not included in artifact list.`);
    }

    // Hashed so the artifact never exposes the correlation_id itself
    const correlationId = github.context.payload.client_payload?.user_config?.correlation_id;
    const sourceCodeDir = path.join(workspaceDir, 'source-code');
    if (correlationId && fs.existsSync(sourceCodeDir)) {
        const hashFilePath = path.join(sourceCodeDir, 'sca-fix-correlation-hash');
        fs.writeFileSync(hashFilePath, crypto.createHash('sha256').update(correlationId).digest('hex'));
        artifactFiles.push(hashFilePath);
    }

    if (artifactFiles.length > 0) {
        const artifactFilePathDir = path.join(workspaceDir, 'source-code');
        core.info('== Start upload ==');
        const artifactClient = new DefaultArtifactClient();
        const uploadResponse = await artifactClient.uploadArtifact(
            'fix-for-sca-artifacts',
            artifactFiles,
            artifactFilePathDir,
            { continueOnError: false }
        );
        core.info('== End upload ==');
    } else {
        core.info('No file to upload.')
    }
}

post();