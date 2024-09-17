const { env } = require('process')

module.exports = async ({ github, core, context, commentId, exec, env, command, args }) => {
  const Comment = require('./comment.cjs')
  const comment = new Comment({ github, context, commentId })
  const { runCommand, createResult, writeNewEnv } = require('./utils.cjs')

  const excuteUpdateKnownGood = async () => {
    const execCommand = `yarn update-known-good`
    const result = await runCommand({ cmd: execCommand, comment, exec })

    if (result.errorOutput || result.exitCode) {
      core.setFailed('Failed to update known good blocks')
      await comment.createOrUpdateComment(createResult({
        context,
        command: execCommand,
        result: result.errorOutput || result.output,
        extra: `**Test Result**: \`Failed to update known good blocks\``
      }))

      process.exit(1)
    }


    return result
  }

  const excuteTest = async (update) => {
    const execCommand = update ?
      `yarn test --reporter tap-flat ${update ? '-u' : ''}` :
      `yarn test --reporter tap-flat ${args.trim()}`

    const result = await runCommand({ cmd: execCommand, comment, exec })

    if (result.errorOutput || result.exitCode) {
      core.setFailed('Tests failed')
      await comment.createOrUpdateComment(createResult({
        context,
        command: execCommand,
        result: result.errorOutput || result.output,
        extra: `**Test Result**: \`Failed\``
      }))
      process.exit(1)
    }

    return result
  }

  if (command === 'run') {
    const updateKnownGoodResult = await excuteUpdateKnownGood();
    const testResult = await excuteTest();
    core.info('Tests Passed')
    const output = updateKnownGoodResult.output + `\n${testResult.output}`
    return comment.createOrUpdateComment(createResult({
      context,
      command: testResult.cmd,
      result: output,
      extra: `**Test Result**: \`Passed\``
    }))
  }

  if (command === 'bump') {
    let newEnv = ''

    if (env) {
      newEnv = writeNewEnv({ env })
    }

    if (!newEnv) {
      const updateKnownGoodResult = await excuteUpdateKnownGood();
      newEnv = updateKnownGoodResult.output + '\n'
    }

    await exec.exec(`git config --global user.name 'github-actions[bot]'`)
    await exec.exec(`git config --global user.email '41898282+github-actions[bot]@users.noreply.github.com'`)
    await exec.exec(`git add KNOWN_GOOD_BLOCK_NUMBERS.env`)
    const diffCachedResult = await exec.exec('git diff --cached --exit-code', null, { ignoreReturnCode: true })
    if (!diffCachedResult) {
      core.setFailed('KNOWN_GOOD_BLOCK_NUMBERS.env not updated')
      await comment.createOrUpdateComment(createResult(`    **KNOWN_GOOD_BLOCK_NUMBERS.env not updated**`))
      process.exit(1)
    }

    const testResult = await excuteTest(true);
    const output = newEnv + `\n${testResult?.output}`

    const diffResult = await exec.exec('git diff --exit-code', null, { ignoreReturnCode: true })

    if (!diffResult) {
      core.info('snapshot not updated')
      await exec.exec(`git`, ['commit', '-am', '[CI Skip] Update KNOWN_GOOD_BLOCK_NUMBERS'])
      await exec.exec('git push')

      let commitId = ''
      await exec.exec('git', ['rev-parse', 'HEAD'], {
        listeners: {
          stdout: (data) => {
            commitId += data.toString();
          }
        }
      })

      return comment.createOrUpdateComment(createResult({
        context,
        command: testResult.cmd,
        result: output,
        extra: `<br/>**KNOWN_GOOD_BLOCK_NUMBERS.env has been updated**<br/>**Commit**: ${commitId}`
      }))
    } else {
      const branchName = `Update-SnapShot-${commentId}`
      await exec.exec(`git checkout -b ${branchName}`)
      await exec.exec(`git`, ['commit', '-am', '[CI Skip] Update snapshots'])


      const commentUrl = `https://github.com/${context.payload.repository.full_name}/issues/${context.issue.number}#issuecomment-${commentId}`
      await exec.exec(`git push origin HEAD:${branchName}`)
      const result = await github.rest.pulls.create({
        owner: context.repo.owner,
        repo: context.repo.repo,
        title: branchName,
        head: branchName,
        base: 'master',
        body: `Update Snapshots (${commentUrl})`,
      })
      core.info(`The Pull request #${result.data.number} has been created to update the snapshot`)
      return comment.createOrUpdateComment(createResult({
        context,
        command: testResult.cmd,
        result: output,
        extra: `<br/>**The Pull request #${result.data.number} has been created to update the snapshot**`
      }))
    }
  }
}