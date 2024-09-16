const createResult = ({ context, command, result, extra }) => {
  return `**Request**: \`${context.payload.comment.body.trim()}\`
**Command**: \`${command}\`
${extra}

<details>
<summary>Results</summary>

\`\`\`
${result}
\`\`\`
</details>
  `
}

module.exports = async ({ github, core, context, commentId, exec, command, args }) => {
  const Comment = require('./comment.cjs')
  const comment = new Comment({ github, context, commentId })

  const execCommand = `yarn update-known-good && yarn test --reporter tap-flat ${command === 'update' ? '-u' : ''} ${args.trim()}`

  await comment.createOrUpdateComment(`Running: \`${execCommand}\``)


  let output = '';
  let errorOutput = '';


  const exitCode = await exec.exec(execCommand, null, {
    ignoreReturnCode: true,
    listeners: {
      stdline: (data) => {
        output += `${data}\n`;
      },
      errline: (data) => {
        errorOutput += `${data}\n`;
      }
    }
  });


  if (errorOutput || exitCode) {
    core.info('Tests failed')
    return comment.createOrUpdateComment(createResult({ command: execCommand, context, result: (errorOutput || output).replace(/\x1b\[[0-9;]*m/g, ''), extra: `**Test Result**: \`false\`` }))
  }

  const testResult = {
    command: execCommand,
    result: output.replace(/\x1b\[[0-9;]*m/g, ''),
    context,
  }

  if (command === 'run') {
    core.info('Tests Passed')
    return comment.createOrUpdateComment(createResult({ ...testResult, extra: `**Test Result**: \`true\`` }))
  }

  const diffResult = await exec.exec('git diff --exit-code', null, { ignoreReturnCode: true })

  if (!diffResult) {
    core.info('Snapshots not updated')
    return comment.createOrUpdateComment(createResult({ ...testResult, extra: `<br/>**Snapshots not updated**` }))
  }

  try {
    const branchName = `update-snapshots-${context.sha.slice(0, 7)}`
    await exec.exec(`git config --global user.name 'github-actions[bot]'`)
    await exec.exec(`git config --global user.email '41898282+github-actions[bot]@users.noreply.github.com'"`)
    await exec.exec(`git checkout -b ${branchName}`)
    await exec.exec(`git`, ['commit', '-am', '[CI Skip] Update snapshots'])
    await exec.exec(`git push origin HEAD:${branchName}`)
    const result = await github.rest.pulls.create({
      owner: context.repo.owner,
      repo: context.repo.repo,
      title: `Update Snapshots #${context.issue.number}`,
      head: branchName,
      base: 'master',
      body: `Update Snapshots #${context.issue.number}`,
    })
    core.info(`The Pull request #${result.data.number} has been created to update the snapshot`)
    return comment.createOrUpdateComment(createResult({ ...testResult, extra: `<br/>**The Pull request #${result.data.number} has been created to update the snapshot**` }))
  } catch (error) {
    console.log(error)
    core.error('Snapshot update failed')
    return comment.createOrUpdateComment(createResult({ ...testResult, extra: `<br/>**Snapshot update failed**` }))
  }
}
