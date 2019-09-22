FROM ubuntu:bionic

# Install package dependencies
RUN export DEBIAN_FRONTEND="noninteractive" \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        apt-transport-https \
        ca-certificates \
        gosu \
        p7zip \
        unzip \
        wget \
        winbind \
        software-properties-common \
        xvfb \
        gpg-agent \
        cabextract
        
ENV WINE_VERSION 4.16

# Install wine
RUN wget https://dl.winehq.org/wine-builds/winehq.key \
    && apt-key add winehq.key \
    && apt-add-repository "deb https://dl.winehq.org/wine-builds/ubuntu/ bionic main" \
    && add-apt-repository ppa:cybermax-dexter/sdl2-backport \
    && dpkg --add-architecture i386 \
    && apt-get update \
    && apt-get install -y --no-install-recommends winehq-devel=${WINE_VERSION}~bionic \
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

# Install node
RUN wget -O- https://deb.nodesource.com/setup_10.x | bash
RUN apt-get install -y nodejs

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

# Create C:\BuildTools
RUN mkdir /home/wineuser/.wine/drive_c/BuildTools

# Install build tools
ADD deps/ /home/wineuser/
WORKDIR /home/wineuser/deps
RUN npm install \
    && node index.js /home/wineuser/.wine/drive_c/BuildTools

ENTRYPOINT ["/usr/bin/entrypoint"]
