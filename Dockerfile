FROM scottyhardy/docker-wine

RUN apt-get update && apt-get -y install xvfb

COPY entrypoint-msvc.sh /usr/bin/entrypoint-msvc
RUN chmod +x /usr/bin/entrypoint-msvc

RUN xvfb-run winetricks -q dotnet452
ADD --chown=wineuser:wineuser https://aka.ms/vs/15/release/vs_buildtools.exe /home/wineuser/vs_BuildTools.exe

RUN xvfb-run wine /home/wineuser/vs_BuildTools.exe --passive --layout c:\BT2017offline --add Microsoft.VisualStudio.Workload.VCTools

ENTRYPOINT ["/usr/bin/entrypoint-msvc"]
