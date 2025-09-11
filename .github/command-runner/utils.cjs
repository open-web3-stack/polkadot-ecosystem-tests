function createResult({ command, context, result, extra }) {
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

// biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional
const ansiEscapeRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g

async function runCommand({ cmd, comment, exec }) {
  let output = ''
  let errorOutput = ''
  await comment.createOrUpdateComment(`Running: \`${cmd}\``)

  const exitCode = await exec.exec(cmd, null, {
    ignoreReturnCode: true,
    listeners: {
      stdline: (data) => {
        output += `${data}\n`
      },
      errline: (data) => {
        errorOutput += `${data}\n`
      },
    },
  })

  return {
    output: output.replace(ansiEscapeRegex, ''),
    errorOutput: errorOutput.replace(ansiEscapeRegex, ''),
    exitCode,
    cmd,
  }
}

function writeNewEnv({ env }) {
  const fs = require('node:fs')

  const envContent = fs.readFileSync('KNOWN_GOOD_BLOCK_NUMBERS.env', 'utf8').toString()

  fs.writeFileSync('.env', env)
  return `# .env
${env}

# KNOWN_GOOD_BLOCK_NUMBERS.env
${envContent}
`
}

module.exports = {
  createResult,
  runCommand,
  writeNewEnv,
}
