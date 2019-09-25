Visual Studio Build Tools in Docker
===================================

Visual Studio Build Tools 2017, running on Wine, running on Ubuntu, running on Docker.

What's in it
------------

 - Ubuntu 18.04
 - Wine 4.16 and winetricks
 - Visual Studio 2017 with the following components and their required dependencies:
   - `Microsoft.VisualStudio.Product.BuildTools`: Visual Studio Build Tools
   - `Microsoft.VisualStudio.Workload.VCTools`: Visual Studio C++ Build Tools
   - `Microsoft.VisualStudio.Workload.UniversalBuildTools`: Universal Windows Platform build tools
 - Windows 10 SDK with the following components:
   - Desktop Headers / Lib / Tools
   - Windows Store Apps Headers / Lib / Tools
   - CRT Header Libraries and Sources
 - Microsoft .NET 4.6.1
 - Windows 2000 Command Prompt
 - Python 2.7
 
Usage
-----

```
$ docker run -it ldiqual/docker-msvc --volume $(pwd):/home/wineuser/workdir
```

This will run the docker container with the current directory mounted in `/home/wineuser/workdir`. You can then use wine to open a developer command prompt.

Developer Command Prompt
------------------------

Visual Studio build tools are located in `C:\BuildTools`. To launch a developer command prompt, run:

```
$ cd ~/workdir
$ wine cmd /k "C:\BuildTools\VC\Auxiliary\Build\vcvars32.bat"
```

This will set your developer prompt environment to compile 32-bit x86 code using native 32-bit tools. Alternatively, you can use:

| Command File | Host and Target architectures
| --- | ---
| vcvars32.bat | Use the 32-bit x86-native tools to build 32-bit x86 code.
| vcvarsx86_amd64.bat | Use the 32-bit x86-native cross tools to build 64-bit x64 code.

Note that this container only has a 32-bit wine prefix, so you can't use the 64-bit based native tools. You can still cross-compile for 64-bit targets though.
For more information, please see [Use the Microsoft C++ toolset from the command line](https://docs.microsoft.com/en-us/cpp/build/building-on-the-command-line?view=vs-2017).
   
Why?
----

I've been trying to cross-compile NodeJS from my mac and only MSVC is supported.
With no access to a Windows machine, I figured that docker + wine could do the job.

Workarounds
-----------

Installing MSVC on wine requires many workarounds, mainly due to wine's limitations:

 - `vs_BuildTools.exe` downloads an OPC file which contains the Visual Studio's install bootstrapper. This OPC file might contain an expired certificate which cannot be validated due to [wine bug #47785](https://bugs.winehq.org/show_bug.cgi?id=47785).
 - The VS bootstrapper downloads the [VS 15 product list](https://aka.ms/vs/15/release/channel) and starts the Installer service to resolve and download dependencies (a bunch of msi, exe, and vsix files). However it seems to expect a version of the Installer service that wine does not provide, so the installation times out.
 - To work around both issues, this image run as script that downloads the release channel and installs packages directly, without the need of the VS installer. Source code of the custom installer can be found in [workarounds/vs-installer](workarounds/vs-installer).
 - To setup the proper [dev environment](https://docs.microsoft.com/en-us/cpp/build/building-on-the-command-line?view=vs-2017) within the windows console, one must execute `vcvars*.bat` which itself calls `VsDevCmd.bat`. This script automatically detects paths for .Net, Windows SDK, CRT, and more. However due to [wine bug #47791](https://bugs.winehq.org/show_bug.cgi?id=47791) this script fails at each detection step. To work around this, `VsDevCmd.bat` is patched using [VsDevCmd.bat.patch](workarounds/VsDevCmd.bat.patch).
 - Wine does not provide a version of [where.exe](https://ss64.com/nt/where.html), which is required by many build scripts. To work around this, Malcolm Smith's [which.exe](http://www.malsmith.net/which/) is placed in `C:\Windows\System32`, and a symbolic link is created from `which.exe` to `where.exe`.

Inspiration
-----------

 - [docker-wine](https://github.com/scottyhardy/docker-wine/blob/master/docker-wine)
 - [docker-wine's fork by boberfly](https://github.com/boberfly/docker-wine)
 - [docker-msvc-wine](https://github.com/boberfly/docker-msvc-wine/blob/master/docker-msvc-wine)
