#!/usr/bin/env tsx

import { createVitest } from 'vitest/node'

import { readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

/**
 * Recursively find all test files in a directory
 */
async function findTestFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory() && entry.name !== '__snapshots__' && entry.name !== 'node_modules') {
        return findTestFiles(fullPath)
      }
      if (entry.isFile() && entry.name.endsWith('.test.ts')) {
        return [fullPath]
      }
      return []
    }),
  )
  return files.flat()
}

/**
 * Recursively visit and print test collection
 */
function visit(collection: any, indent: string = '', isLast: boolean = true): { tests: number; suites: number } {
  let tests = 0
  let suites = 0

  const tasks = Array.from(collection)

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]
    const isLastTask = i === tasks.length - 1
    const connector = isLastTask ? '└─ ' : '├─ '
    const nextIndent = indent + (isLastTask ? '  ' : '│ ')

    if (task.type === 'suite') {
      console.log(`${indent}${connector}📦 ${task.name}`)
      suites++

      const childCounts = visit(task.children, nextIndent, isLastTask)
      tests += childCounts.tests
      suites += childCounts.suites
    } else if (task.type === 'test') {
      console.log(`${indent}${connector}✓ ${task.name}`)
      tests++
    }
  }

  return { tests, suites }
}

/**
 * Main function
 */
async function main() {
  const network = process.argv[2]
  const chain = process.argv[3]

  if (!network) {
    console.error('Usage: tsx scripts/print-test-tree.ts <network> [chain]')
    console.error('')
    console.error('Examples:')
    console.error('  tsx scripts/print-test-tree.ts kusama              # All Kusama tests')
    console.error('  tsx scripts/print-test-tree.ts kusama assetHub     # AssetHub Kusama tests only')
    console.error('  tsx scripts/print-test-tree.ts kusama kusama       # Kusama relay chain only')
    console.error('  tsx scripts/print-test-tree.ts polkadot people     # People Polkadot tests only')
    process.exit(1)
  }

  try {
    const filterInfo = chain ? ` (chain: ${chain})` : ''
    console.log(`\n🔍 Collecting tests for network: ${network}${filterInfo}...\n`)

    const packagesDir = resolve(process.cwd(), 'packages', network, 'src')

    // Find all test files
    let testFiles = await findTestFiles(packagesDir)

    // Filter by chain if specified
    if (chain) {
      const chainPattern = chain.charAt(0).toLowerCase() + chain.slice(1)
      testFiles = testFiles.filter((file) => {
        const fileName = file.split('/').pop() || ''
        return fileName.toLowerCase().startsWith(chainPattern.toLowerCase())
      })
    }

    if (testFiles.length === 0) {
      console.log('⚠️  No test files found!')
      return
    }

    // Print header
    console.log('='.repeat(80))
    const title = chain
      ? `TEST TREE STRUCTURE FOR: ${network.toUpperCase()} - ${chain.toUpperCase()}`
      : `TEST TREE STRUCTURE FOR: ${network.toUpperCase()}`
    console.log(title)
    console.log('='.repeat(80))

    let totalTests = 0
    let totalSuites = 0
    let totalFiles = 0

    // Collect and print each file
    for (const file of testFiles.sort()) {
      const relPath = relative(packagesDir, file)

      // Create fresh vitest instance for each file to avoid state accumulation
      const vitest = await createVitest('test', {
        watch: false,
        run: false,
      })

      // Collect tests from this file
      const result = await vitest.collect([file])

      // Close immediately after collection
      await vitest.close()

      if (!result || !result.testModules || result.testModules.length === 0) {
        continue
      }

      console.log(`\n📄 ${relPath}`)
      console.log('─'.repeat(80))

      // Visit all test modules
      const fileCounts = { tests: 0, suites: 0 }
      for (const module of result.testModules) {
        const counts = visit(module.children, '', true)
        fileCounts.tests += counts.tests
        fileCounts.suites += counts.suites
      }

      totalTests += fileCounts.tests
      totalSuites += fileCounts.suites
      totalFiles++

      console.log(`\n   Tests: ${fileCounts.tests}, Suites: ${fileCounts.suites}`)
    }

    console.log(`\n${'='.repeat(80)}`)
    console.log('SUMMARY')
    console.log('='.repeat(80))
    console.log(`Total files: ${totalFiles}`)
    console.log(`Total tests: ${totalTests}`)
    console.log(`Total suites: ${totalSuites}`)
    console.log('='.repeat(80) + '\n')
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error)
    if (error instanceof Error && error.stack) {
      console.error(error.stack)
    }
    process.exit(1)
  }
}

main()
