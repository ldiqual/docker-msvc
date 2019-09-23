FROM ubuntu:bionic

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
        patch
        
# Install node
RUN wget -O- https://deb.nodesource.com/setup_10.x | bash
RUN apt-get install -y nodejs

ENV WINE_VERSION 4.16

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

ENV ADDONS_C_URL https://raw.githubusercontent.com/wine-mirror/wine/wine-${WINE_VERSION}/dlls/appwiz.cpl/addons.c

# Install wine-mono
RUN mkdir -p /usr/share/wine/mono
RUN MONO_VERSION=$(wget -O- ${ADDONS_C_URL} | grep '#define MONO_VERSION' | sed -n 's/.*"\(.*\)"/\1/p') \
    && wget https://dl.winehq.org/wine/wine-mono/${MONO_VERSION}/wine-mono-${MONO_VERSION}.msi -O /usr/share/wine/mono/wine-mono-${MONO_VERSION}.msi \
    && chown wineuser:wineuser /usr/share/wine/mono/wine-mono-${MONO_VERSION}.msi

# Install wine-gecko
RUN mkdir -p /usr/share/wine/gecko
RUN GECKO_VERSION=$(wget -O- ${ADDONS_C_URL} | grep '#define GECKO_VERSION' | sed -n 's/.*"\(.*\)"/\1/p') \
    && wget https://dl.winehq.org/wine/wine-gecko/${GECKO_VERSION}/wine_gecko-${GECKO_VERSION}-x86.msi -O /usr/share/wine/gecko/wine_gecko-${GECKO_VERSION}-x86.msi \
    && wget https://dl.winehq.org/wine/wine-gecko/${GECKO_VERSION}/wine_gecko-${GECKO_VERSION}-x86_64.msi -O /usr/share/wine/gecko/wine_gecko-${GECKO_VERSION}-x86_64.msi \
    && chown wineuser:wineuser /usr/share/wine/gecko/wine_gecko-${GECKO_VERSION}-x86.msi \
    && chown wineuser:wineuser /usr/share/wine/gecko/wine_gecko-${GECKO_VERSION}-x86_64.msi

# Now we're wineuser
USER wineuser:wineuser

RUN WINEARCH=win32 xvfb-run --auto-servernum wine wineboot --init \
    && xvfb-run --auto-servernum winetricks -q dotnet461 cmd

# Install Build Tools
# Workaround for https://bugs.winehq.org/show_bug.cgi?id=47785 which prevents vs_BuildTools.exe from validating microsoft certificates
RUN mkdir /home/wineuser/deps /home/wineuser/.wine/drive_c/BuildTools
COPY deps/. /home/wineuser/deps/
RUN cd /home/wineuser/deps \
    && npm install \
    && xvfb-run --auto-servernum \
        node ./index.js /home/wineuser/.wine/drive_c/BuildTools
        
# Download & extract windows SDK
RUN wget https://go.microsoft.com/fwlink/p/?linkid=870809 -O /home/wineuser/win10sdk.iso \
    && mkdir /home/wineuser/win10sdk \
    && cd /home/wineuser/win10sdk \
    && 7z x ../win10sdk.iso \
    && rm ../win10sdk.iso

# Install Windows SDK
RUN cd /home/wineuser/win10sdk/Installers \
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
    && wine msiexec /i "Universal CRT Headers Libraries and Sources-x86_en-us.msi" /qn
    
# Patch VsDevCmd.bat to workaround https://bugs.winehq.org/show_bug.cgi?id=47791
COPY ./VsDevCmd.bat.patch /home/wineuser/VsDevCmd.bat.patch
RUN patch \
    /home/wineuser/.wine/drive_c/BuildTools/Common7/Tools/VsDevCmd.bat \
    /home/wineuser/VsDevCmd.bat.patch

ENTRYPOINT ["/usr/bin/entrypoint"]
