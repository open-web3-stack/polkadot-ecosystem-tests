// Helper function to decode and log dispatch errors
function logDispatchError(dispatchError: any, client: any, indentation = '     ') {
  try {
    if (dispatchError.isModule) {
      const moduleError = dispatchError.asModule
      console.log(`${indentation}Type: Module Error`)
      console.log(`${indentation}Module Index: ${moduleError.index.toNumber()}`)
      console.log(`${indentation}Error Code: ${moduleError.error.toHex()}`)

      // Try to decode the error
      try {
        const errorRegistry = client.api.registry.findMetaError(moduleError)
        if (errorRegistry) {
          console.log(`${indentation}Decoded: ${errorRegistry.section}.${errorRegistry.method}`)
          console.log(`${indentation}Docs: ${errorRegistry.docs.join(' ')}`)
        } else {
          // Try alternative decoding
          const errorCodeNum = moduleError.error.toNumber()
          const errorIndex = errorCodeNum & 0xffff
          const palletName = client.api.registry.getModuleName(moduleError.index.toNumber())
          console.log(
            `${indentation}Could not find in registry. Pallet: ${palletName || 'unknown'}, Error Index: ${errorIndex}`,
          )
        }
      } catch (decodeErr) {
        console.log(`${indentation}Could not decode error: ${decodeErr}`)

        // Try alternative: decode error from the encoded error code
        try {
          console.log(`${indentation}Trying to decode error from module index and error code...`)
          const errorCodeNum = moduleError.error.toNumber()
          console.log(`${indentation}Error code as number: ${errorCodeNum}`)

          // The error code format is: 0x04000000 = moduleIndex << 24 | errorIndex
          // Extract the error index from the error code
          const errorIndex = errorCodeNum & 0xffff
          console.log(`${indentation}Error Index: ${errorIndex}`)

          // Try to find which pallet has this index
          const palletName = client.api.registry.getModuleName(moduleError.index.toNumber())
          if (palletName) {
            console.log(`${indentation}Module/Pallet: ${palletName}`)
          }
        } catch (altErr) {
          console.log(`${indentation}Alternative decode also failed: ${altErr}`)
        }
      }
    } else if (dispatchError.isToken) {
      console.log(`${indentation}Type: Token Error`)
      console.log(`${indentation}Details: ${JSON.stringify(dispatchError.asToken.toHuman())}`)
    } else if (dispatchError.isArithmetic) {
      console.log(`${indentation}Type: Arithmetic Error`)
      console.log(`${indentation}Details: ${JSON.stringify(dispatchError.asArithmetic.toHuman())}`)
    } else if (dispatchError.isTransactional) {
      console.log(`${indentation}Type: Transactional Error`)
      console.log(`${indentation}Details: ${JSON.stringify(dispatchError.asTransactional.toHuman())}`)
    } else {
      console.log(`${indentation}Type: Other`)
      console.log(`${indentation}Details: ${JSON.stringify(dispatchError.toHuman())}`)
    }
  } catch (err) {
    console.log(`${indentation}Could not parse error details: ${err}`)
  }
}

// Log all events
export async function logAllEvents(client: any) {
  const events = await client.api.query.system.events()

  // Process each event
  events.forEach((evt: any, idx: number) => {
    // dont log the voterList section
    if (evt.event?.section === 'voterList') {
      return
    }
    console.log(`Event #${idx} [${evt.event?.section}]:`, evt.event?.toHuman?.() ?? evt.event)

    // For scheduler Dispatched events with errors, log detailed error information
    if (evt.event?.section === 'scheduler' && evt.event?.method === 'Dispatched') {
      const dispatchData = evt.event.data
      if (dispatchData?.result?.isErr) {
        console.log(`  └─ Error Details:`)
        const dispatchError = dispatchData.result.asErr
        logDispatchError(dispatchError, client, '     ')
      }
    }

    // For ExtrinsicFailed events, log detailed error information
    if (evt.event?.section === 'system' && evt.event?.method === 'ExtrinsicFailed') {
      console.log(`\n=== ExtrinsicFailed Event #${idx} ===`)
      console.log('Event:', evt.event?.toHuman?.() ?? evt.event)

      const eventData = evt.event.data
      if (eventData?.dispatchError) {
        const dispatchError = eventData.dispatchError
        console.log('\n--- Error Details ---')
        logDispatchError(dispatchError, client, '  ')
      }

      if (eventData?.dispatchInfo) {
        console.log('\n--- Dispatch Info ---')
        console.log('Weight:', eventData.dispatchInfo.weight.toHuman?.() ?? eventData.dispatchInfo.weight)
        console.log('Class:', eventData.dispatchInfo.class.toHuman?.() ?? eventData.dispatchInfo.class)
        console.log('Pays Fee:', eventData.dispatchInfo.paysFee.toHuman?.() ?? eventData.dispatchInfo.paysFee)
      }
    }
  })
}
