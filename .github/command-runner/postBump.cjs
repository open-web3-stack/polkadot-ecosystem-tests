module.exports = async ({ github, context, exec, commentId, core, testResult }) => {
  const Comment = require('./comment.cjs')
  const comment = new Comment({ github, context, commentId })

  if (testResult !== 'success') {
    return comment.createOrUpdateComment(`    Test failed`)
  }

  const diffResult = await exec.exec('git diff --exit-code', null, { ignoreReturnCode: true })

  if (!diffResult) {
    core.info('KNOWN_GOOD_BLOCK_NUMBERS files not updated')
    return comment.createOrUpdateComment(`    KNOWN_GOOD_BLOCK_NUMBERS files not updated`)
  }

  await exec.exec(`git config --global user.name 'github-actions[bot]'`)
  await exec.exec(`git config --global user.email '41898282+github-actions[bot]@users.noreply.github.com'`)
  await exec.exec(`git add KNOWN_GOOD_BLOCK_NUMBERS_KUSAMA.env KNOWN_GOOD_BLOCK_NUMBERS_POLKADOT.env`)
  await exec.exec(`git`, ['commit', '-am', '[ci skip] Update KNOWN_GOOD_BLOCK_NUMBERS files'])
  await exec.exec('git push')

  let commitId = ''
  await exec.exec('git', ['rev-parse', 'HEAD'], {
    listeners: {
      stdout: (data) => {
        commitId += data.toString()
      },
    },
  })

  return comment.createOrUpdateComment(
    `**KNOWN_GOOD_BLOCK_NUMBERS files have been updated**<br/>**Commit**: ${commitId}`,
  )
}
