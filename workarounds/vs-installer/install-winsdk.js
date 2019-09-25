'use strict'

const _ = require('lodash')
const path = require('path')
const tmp = require('tmp-promise')
const yargs = require('yargs')
const Promise = require('bluebird')
const fs = require('fs-extra')
const xml2js = require('xml2js')
const readChunk = require('read-chunk')
const globby = require('globby')
const rp = require('request-promise')

const utils = require('./lib/utils')

function isSupportedInstallCondition(installCondition) {
        
    if (!installCondition) {
        return true
    }
    
    const archRegex = /Arch = "(.*)"/
    const matches = installCondition.match(archRegex)
    if (!matches) {
        return true
    }
    
    return !_.includes(['amd64', 'arm'], matches[1])
}

async function run({ installDir, isDryRun }) {
    
    if (isDryRun) {
        console.log('Running installer in dry-run mode')
    }
    
    const { path: downloadDir } = await tmp.dir({ unsafeCleanup: true })
    
    // Download Win SDK Installer
    const installerPath = path.join(downloadDir, 'winsdk-installer.exe')
    await utils.downloadFile({
        src: 'https://go.microsoft.com/fwlink/p/?linkid=2083338&clcid=0x409',
        dst: installerPath
    })
    
    // Extract installer to inspect its xml files
    await utils.runCommand('7z', [
        'x',
        `-o${downloadDir}`,
        installerPath
    ])
    
    const burnManifestPath = path.join(downloadDir, '0')
    const burnManifestString = await fs.readFile(burnManifestPath, 'utf8')
    const burnManifest = await xml2js.parseStringPromise(burnManifestString)
    
    const remainingFilesPaths = await globby('u*', {
        cwd: downloadDir,
        absolute: true
    })
    
    const uxManifestPath = _.first(await Promise.filter(remainingFilesPaths, async path => {
        const buffer = readChunk.sync(path, 0, 23)
        return buffer.toString() === '<UserExperienceManifest'
    }))
    
    const uxManifestString = await fs.readFile(uxManifestPath, 'utf8')
    const uxManifest = await xml2js.parseStringPromise(uxManifestString)
    
    // http://go.microsoft.com/fwlink/?prd=11966&pver=1.0&plcid=0x409&clcid=0x409&ar=Windows10&sar=SDK&o1=10.0.18362.1
    // Resolves to https://download.microsoft.com/download/4/2/2/42245968-6A79-4DA7-A5FB-08C0AD0AE661/windowssdk/
    const rootDownloadUrl = uxManifest.UserExperienceManifest.Settings[0].SourceResolution[0].DownloadRoot[0]
    const urlResolveResponse = await rp({
        url: rootDownloadUrl,
        followRedirect: false,
        resolveWithFullResponse: true,
        simple: false,
    })
    const downloadUrl = urlResolveResponse.headers.location
    console.log('Download URL', downloadUrl)
    
    const allOptions = uxManifest.UserExperienceManifest.Options[0].Option
    
    const baseOptionIds = [
        'OptionId.SigningTools',
        'OptionId.UWPManaged',
        'OptionId.UWPCPP',
        'OptionId.DesktopCPPx86',
        'OptionId.DesktopCPPx64'
    ]
    
    // Extract packages and their payload from the uxManifest and the burnManifest
    const allPackages = _.flatten(_.map(baseOptionIds, optionId => {
        const optionObj = _.find(allOptions, opt => opt.$.Id === optionId)
        const packages = _.map(optionObj.Packages[0].Package, pkg => {
            return {
                id: pkg.$.Id,
                installCondition: pkg.$.InstallCondition
            }
        })
        
        const filteredPackageIds = _.filter(packages, pkg => {
            const isSupported = isSupportedInstallCondition(pkg.installCondition)
            
            if (!isSupported) {
                console.log(`Ignoring msi package ${pkg.id} because it doesn't have a supported install condition`)
            }
            
            return isSupported
        })
        
        return _.compact(_.map(filteredPackageIds, pkg => {
            const pkgInBurnManifest = _.find(burnManifest.BurnManifest.Chain[0].MsiPackage, pkgInBurnManifest => pkgInBurnManifest.$.Id === pkg.id)
            
            if (!isSupportedInstallCondition(pkgInBurnManifest.$.InstallCondition)) {
                console.log(`Ignoring msi package ${pkgInBurnManifest.$.Id} because it doesn't have a supported install condition`)
                return null
            }
            
            const payloads = _.map(pkgInBurnManifest.PayloadRef, payloadRef => {
                const payload = _.find(burnManifest.BurnManifest.Payload, payload => payload.$.Id === payloadRef.$.Id)                
                return {
                    urlPath: payload.$.FilePath,
                    fileName: _.last(payload.$.FilePath.split('\\')),
                    size: Number(payload.$.FileSize)
                }
            })
            
            const msiProperties = _.mapValues(_.keyBy(pkgInBurnManifest.MsiProperty, '$.Id'), '$.Value')
            return {
                id: pkg.id,
                msiProperties,
                payloads
            }
        }))
    }))
    
    console.log('Packages to install', allPackages.map(pkg => pkg.id))
    
    // Generate payload file list
    const files = _.flatten(_.map(allPackages, pkg => {
        return _.map(pkg.payloads, payload => {
            return {
                src: `${downloadUrl}${payload.urlPath}`,
                dst: path.join(downloadDir, pkg.id, payload.fileName),
                size: payload.size
            }
        })
    }))
    
    // Download payloads
    await utils.downloadFiles({
        files,
        isDryRun
    })
    
    for (const pkg of allPackages) {
        
        const msiPayload = _.find(pkg.payloads, payload => _.endsWith(payload.fileName, 'msi'))
        
        const replacements = {
            '[LogFile]': `C:\\Users\\wineuser\\Temp\\${pkg.name}.log`,
            '[Payload]': msiPayload.fileName,
            '[CEIPConsent]': '',
            '[SharedInstallDir]': 'C:\\Program Files',
            '[UserLocale]': 'en-us',
            '[KITSROOT]': 'C:\\Program Files\\Windows Kits\\10'
        }
        const installParams = _.mapValues(pkg.msiProperties || {}, (paramValue, paramKey) => {
            return replacements[paramValue] || paramValue
        })
        
        console.log(`Installing ${pkg.id}`)
        
        if (isDryRun) {
            continue
        }
        
        await utils.runCommand('msiexec', [
            '/i', path.join(downloadDir, pkg.id, msiPayload.fileName),
            ..._.map(installParams, (value, key) => `${key}=${value}`),
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
