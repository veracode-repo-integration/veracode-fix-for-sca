const fs = require('fs');
const path = require('path');
const core = require('@actions/core');
const github = require('@actions/github');

/**
 * Materialize the fix_id-enriched results.json for the SAST fix.
 *
 * veracode-github-app stores the enriched results.json (full 1-results.json + fix_id) as a
 * git blob in the `veracode` repo and dispatches only the blob SHA (client_payload cannot
 * carry the full base64 due to GitHub's ~64 KB limit). This fetches that blob and writes it
 * to veracode_artifact_directory/results.json, which run-fix-sast.js then reads.
 *
 * @param {string} workspaceDir - GITHUB_WORKSPACE
 * @param {string} repository - "owner/repo" of the target repo; owner also owns the veracode repo
 * @param {string} githubToken - token with read access to the veracode repo
 * @param {string} githubApiUrl - GitHub API base URL (cloud or GHES)
 * @param {string} resultsBlobSha - git blob SHA of the enriched results.json
 * @param {string} veracodeRepo - repo the blob lives in (default: "veracode")
 * @returns {Promise<string>} path to the written results.json
 */
async function fetchSastResultsBlob(workspaceDir, repository, githubToken, githubApiUrl, resultsBlobSha, veracodeRepo = 'veracode') {
  const owner = (repository || '').split('/')[0];
  if (!owner) {
    throw new Error(`Unable to determine owner from repository input: "${repository}"`);
  }

  const options = {};
  if (githubApiUrl) {
    options.baseUrl = githubApiUrl.replace(/\/+$/, '');
  }
  const octokit = github.getOctokit(githubToken, options);

  core.info(`Fetching enriched SAST results blob ${resultsBlobSha} from ${owner}/${veracodeRepo}`);
  const { data } = await octokit.rest.git.getBlob({
    owner,
    repo: veracodeRepo,
    file_sha: resultsBlobSha,
  });

  const content = Buffer.from(data.content, data.encoding).toString('utf8');

  const artifactDir = path.join(workspaceDir, 'veracode_artifact_directory');
  fs.mkdirSync(artifactDir, { recursive: true });
  const resultsFilePath = path.join(artifactDir, 'results.json');
  fs.writeFileSync(resultsFilePath, content);

  core.info(`Wrote enriched results.json (${content.length} bytes) to ${resultsFilePath}`);
  return resultsFilePath;
}

module.exports = fetchSastResultsBlob;
