FROM scottyhardy/docker-wine

RUN apt-get update && apt-get -y install xvfb

COPY entrypoint.sh /usr/bin/entrypoint
RUN chmod +x /usr/bin/entrypoint

RUN xvfb-run --auto-servernum winetricks -q dotnet452
ADD --chown=wineuser:wineuser https://aka.ms/vs/15/release/vs_buildtools.exe /home/wineuser/vs_BuildTools.exe

RUN xvfb-run --auto-servernum wine /home/wineuser/vs_BuildTools.exe --passive --layout c:\BT2017offline --add Microsoft.VisualStudio.Workload.VCTools

ENTRYPOINT ["/usr/bin/entrypoint"]
