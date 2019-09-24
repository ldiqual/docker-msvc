FROM ubuntu:bionic

ENV WINE_VERSION 4.16
ENV WINEPATH "C:\\Python27\\;C:\\Python27\\Scripts"

# Install package dependencies
RUN export DEBIAN_FRONTEND="noninteractive" \
    && apt-get update \
    && apt-get install -y \
        --no-install-recommends \
        apt-transport-https \
        ca-certificates \
        gosu \
        p7zip-full \
        unzip \
        wget \
        winbind \
        software-properties-common \
        xvfb \
        gpg-agent \
        cabextract \
        patch \
        vim
        
# Install node
RUN wget -O- https://deb.nodesource.com/setup_10.x | bash
RUN apt-get install -y nodejs

# Install wine
RUN wget https://dl.winehq.org/wine-builds/winehq.key \
    && apt-key add winehq.key \
    && apt-add-repository "deb https://dl.winehq.org/wine-builds/ubuntu/ bionic main" \
    && add-apt-repository ppa:cybermax-dexter/sdl2-backport \
    && dpkg --add-architecture i386 \
    && apt-get update \
    && apt-get install -y --install-recommends winehq-devel=${WINE_VERSION}~bionic \
    && rm winehq.key

# Create wineuser
RUN groupadd -g 1010 wineuser \
    && useradd --shell /bin/bash --uid 1010 --gid 1010 --create-home --home-dir /home/wineuser wineuser \
    && chown -R wineuser:wineuser /home/wineuser

# Install entrypoint
COPY entrypoint.sh /usr/bin/entrypoint
RUN chmod +x /usr/bin/entrypoint

# Install winetricks
ADD --chown=wineuser:wineuser https://raw.githubusercontent.com/Winetricks/winetricks/master/src/winetricks /usr/bin/winetricks
RUN chmod +x /usr/bin/winetricks

# Url of wine's addons.c which contains the mono & gecko versions specific to this wine release
# Example: https://github.com/wine-mirror/wine/blob/wine-4.16/dlls/appwiz.cpl/addons.c#L61
ENV ADDONS_C_URL https://raw.githubusercontent.com/wine-mirror/wine/wine-${WINE_VERSION}/dlls/appwiz.cpl/addons.c

# Download wine-mono for later automatic install by wineboot
RUN mkdir -p /usr/share/wine/mono
RUN MONO_VERSION=$(wget -O- ${ADDONS_C_URL} | grep '#define MONO_VERSION' | sed -n 's/.*"\(.*\)"/\1/p') \
    && wget https://dl.winehq.org/wine/wine-mono/${MONO_VERSION}/wine-mono-${MONO_VERSION}.msi -O /usr/share/wine/mono/wine-mono-${MONO_VERSION}.msi \
    && chown wineuser:wineuser /usr/share/wine/mono/wine-mono-${MONO_VERSION}.msi

# Install wine-gecko for later automatic install by wineboot
RUN mkdir -p /usr/share/wine/gecko
RUN GECKO_VERSION=$(wget -O- ${ADDONS_C_URL} | grep '#define GECKO_VERSION' | sed -n 's/.*"\(.*\)"/\1/p') \
    && wget https://dl.winehq.org/wine/wine-gecko/${GECKO_VERSION}/wine_gecko-${GECKO_VERSION}-x86.msi -O /usr/share/wine/gecko/wine_gecko-${GECKO_VERSION}-x86.msi \
    && wget https://dl.winehq.org/wine/wine-gecko/${GECKO_VERSION}/wine_gecko-${GECKO_VERSION}-x86_64.msi -O /usr/share/wine/gecko/wine_gecko-${GECKO_VERSION}-x86_64.msi \
    && chown wineuser:wineuser /usr/share/wine/gecko/wine_gecko-${GECKO_VERSION}-x86.msi \
    && chown wineuser:wineuser /usr/share/wine/gecko/wine_gecko-${GECKO_VERSION}-x86_64.msi
    
ENV ADDONS_C_URL=

# Now we're wineuser
USER wineuser:wineuser
WORKDIR /home/wineuser

# Create a 32-bit wine prefix and install .NET
RUN WINEARCH=win32 xvfb-run --auto-servernum wine wineboot --init \
    && xvfb-run --auto-servernum winetricks -q dotnet461 cmd

# Install Build Tools
# Workaround for https://bugs.winehq.org/show_bug.cgi?id=47785 which prevents vs_BuildTools.exe from validating microsoft certificates
RUN mkdir ${HOME}/vs-installer ${HOME}/.wine/drive_c/BuildTools
COPY workarounds/vs-installer/. /home/wineuser/vs-installer/
RUN cd ${HOME}/vs-installer \
    && npm install \
    && xvfb-run --auto-servernum \
        node ./index.js ${HOME}/.wine/drive_c/BuildTools \
    && rm -rf ${HOME}/deps

# Download & extract windows SDK
RUN wget https://go.microsoft.com/fwlink/p/?linkid=870809 -O ${HOME}/win10sdk.iso \
    && mkdir ${HOME}/win10sdk \
    && cd ${HOME}/win10sdk \
    && 7z x ../win10sdk.iso \
    && rm ../win10sdk.iso

# Install Windows SDK
RUN cd ${HOME}/win10sdk/Installers \
    && winetricks -q win10 \
    && wine msiexec /i "Windows SDK Desktop Headers x64-x86_en-us.msi" /qn \
    && wine msiexec /i "Windows SDK Desktop Headers x86-x86_en-us.msi" /qn \
    && wine msiexec /i "Windows SDK Desktop Libs x64-x86_en-us.msi" /qn \
    && wine msiexec /i "Windows SDK Desktop Libs x86-x86_en-us.msi" /qn \
    && wine msiexec /i "Windows SDK Desktop Tools x64-x86_en-us.msi" /qn \
    && wine msiexec /i "Windows SDK Desktop Tools x86-x86_en-us.msi" /qn \
    && wine msiexec /i "Windows SDK for Windows Store Apps Headers-x86_en-us.msi" /qn \
    && wine msiexec /i "Windows SDK for Windows Store Apps Libs-x86_en-us.msi" /qn \
    && wine msiexec /i "Windows SDK for Windows Store Apps Tools-x86_en-us.msi" /qn \
    && wine msiexec /i "Windows SDK for Windows Store Apps Legacy Tools-x86_en-us.msi" /qn \
    && wine msiexec /i "Universal CRT Headers Libraries and Sources-x86_en-us.msi" /qn \
    && rm -rf ${HOME}/win10sdk

# Install Python 2.7
RUN wget https://www.python.org/ftp/python/2.7.16/python-2.7.16.msi -O ${HOME}/python-2.7.16.msi \
    && wine msiexec /i ${HOME}/python-2.7.16.msi /q \
    && rm ${HOME}/python-2.7.16.msi
    
# Patch VsDevCmd.bat to workaround https://bugs.winehq.org/show_bug.cgi?id=47791
COPY workarounds/VsDevCmd.bat.patch /home/wineuser/VsDevCmd.bat.patch
RUN patch \
    ${HOME}/.wine/drive_c/BuildTools/Common7/Tools/VsDevCmd.bat \
    ${HOME}/VsDevCmd.bat.patch \
    && rm ${HOME}/VsDevCmd.bat.patch

# Install which.exe which serves as a replacement for the missing where.exe
RUN wget http://www.malsmith.net/download/?obj=which/latest-stable/win32-unicode/which.exe -O ${HOME}/.wine/drive_c/windows/system32/which.exe \
    && ln -s ${HOME}/.wine/drive_c/windows/system32/which.exe ${HOME}/.wine/drive_c/windows/system32/where.exe

ENTRYPOINT ["bash"]
CMD ["bash"]
