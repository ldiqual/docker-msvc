'use strict'

const _ = require('lodash')
const path = require('path')
const tmp = require('tmp-promise')
const fetch = require('node-fetch')
const Papa = require('papaparse')
const yargs = require('yargs')
const Promise = require('bluebird')

const utils = require('./lib/utils')

async function installWindowsSDK({ catalogJson, isDryRun }) {
    
    console.log('Downloading & Installing Windows SDK')
    
    const toolsPackage = _.find(catalogJson.packages, pkg => pkg.id === 'Microsoft.VisualStudio.Workload.VCTools')
    const winSdkDependency = _.first(_.keys(
        _.pickBy(toolsPackage.dependencies, (depObject, depId) => {
            if (!_.isObject(depObject)) {
                return false
            }
            return depObject.type.toLowerCase() === 'recommended'
                && _.startsWith(depId, 'Microsoft.VisualStudio.Component.Windows10SDK')
        })
    ))
    const winSdkVersion = _.last(winSdkDependency.split('.'))
    console.log(`Windows SDK version ${winSdkVersion}`)
    
    const exePackage = _.find(catalogJson.packages, pkg => pkg.id === `Win10SDK_10.0.${winSdkVersion}`)
    
    // To get a list of available Windows SDK components, run:
    // $ cat channel.vsman.json | jq '.packages[] | select(.id =="Win10SDK_10.0.17763") | .payloads[].fileName' | grep -i msi
    const msiNames = [
        'Windows SDK Modern Versioned Developer Tools-x86_en-us.msi',
        'Windows SDK Desktop Headers x64-x86_en-us.msi',
        'Windows SDK Desktop Headers x86-x86_en-us.msi',
        'Windows SDK Desktop Libs x64-x86_en-us.msi',
        'Windows SDK Desktop Libs x86-x86_en-us.msi',
        'Windows SDK Desktop Tools x64-x86_en-us.msi',
        'Windows SDK Desktop Tools x86-x86_en-us.msi',
        'Windows SDK for Windows Store Apps Headers-x86_en-us.msi',
        'Windows SDK for Windows Store Apps Libs-x86_en-us.msi',
        'Windows SDK for Windows Store Apps Tools-x86_en-us.msi',
        'Windows SDK for Windows Store Apps Legacy Tools-x86_en-us.msi',
        'Universal CRT Headers Libraries and Sources-x86_en-us.msi',
    ]
    
    // Generate a list of MSI files to download
    const { path: downloadDir } = await tmp.dir({ unsafeCleanup: true })
    const msiFiles = _.map(msiNames, msiName => {
        const msiPayload = _.find(exePackage.payloads, payload => _.endsWith(payload.fileName, msiName))
        return {
            src: msiPayload.url,
            dst: path.join(downloadDir, msiName),
            size: msiPayload.size,
        }
    })
    
    // Download MSI files
    await utils.downloadFiles({
        files: msiFiles,
        isDryRun
    })
    
    // Inspect each MSI file and generate a list of .cab files to download
    const cabFiles = _.flatten(await Promise.map(msiNames, async msiName => {
        
        if (isDryRun) {
            return []
        }
                
        const output = await utils.runCommand('msiinfo', [
            'export',
            path.join(downloadDir, msiName),
            'Media'
        ])
        
        const medias = Papa.parse(output.stdout, { header: true })
        const cabNames = _.map(_.filter(medias.data, media => {
            return !_.startsWith(media.Cabinet, '#') && _.endsWith(media.Cabinet, '.cab')
        }), 'Cabinet')
        
        return _.map(cabNames, cabName => {
            const cabPayload = _.find(exePackage.payloads, payload => _.endsWith(payload.fileName, cabName))
            return {
                src: cabPayload.url,
                dst: path.join(downloadDir, cabName),
                size: cabPayload.size,
            }
        })
    }))
    
    // Download CAB files
    await utils.downloadFiles({
        files: cabFiles,
        isDryRun
    })
    
    // Install MSI files now that their associated CAB files are downloaded
    for (const msiName of msiNames) {
        console.log(`Installing ${msiName}`)
        await utils.runCommand('msiexec', [
            '/i', path.join(downloadDir, msiName),
            '/qn',
        ], {
            env: {
                ...process.env,
                WINEDEBUG: '-all,+msiexec'
            },
            isDryRun
        })
    }
}

async function run({ installDir, isDryRun }) {
    
    if (isDryRun) {
        console.log('Running installer in dry-run mode')
    }
    
    // Download manifest
    const manifestUrl = 'https://aka.ms/vs/15/release/channel'
    const manifest = await (await fetch(manifestUrl)).json()
    
    // Extract catalog url from manifest and download it
    // Eg: https://download.visualstudio.microsoft.com/download/pr/82e3dcda-e8a0-44e4-8860-eb93a12d4e80/61c5d0ed852e311c8fd6a62627fcb326da6aa79028b40ae25ee062da3c33791b/VisualStudio.vsman
    const catalog = _.find(manifest.channelItems, item => {
        return item.type.toLowerCase() === 'manifest' && item.id === 'Microsoft.VisualStudio.Manifests.VisualStudio'
    })
    const catalogUrl = catalog.payloads[0].url
    const catalogJson = await (await fetch(catalogUrl)).json()
    
    // Install Win SDK separately, because the installer won't work
    await installWindowsSDK({ catalogJson, isDryRun })
}

yargs
.option('dry-run', {
    describe: 'Run the installer without downloading or installing components',
    type: 'boolean'
})

const args = yargs.argv

run({
    isDryRun: args.dryRun || false
}).catch(err => {
    console.error(err.stack)
    process.exit(1)
})
