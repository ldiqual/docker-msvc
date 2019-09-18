FROM scottyhardy/docker-wine

RUN apt-get update && apt-get -y install xvfb
COPY xvfb-start.sh /usr/bin/xvfb-start
RUN chmod +x /usr/bin/xvfb-start
ENV DISPLAY=:99

COPY entrypoint-msvc.sh /usr/bin/entrypoint-msvc
RUN chmod +x /usr/bin/entrypoint-msvc

RUN xvfb-start && winetricks -q dotnet452
ADD --chown=wineuser:wineuser https://aka.ms/vs/15/release/vs_buildtools.exe /home/wineuser/vs_BuildTools.exe

RUN xvfb-start && wine /home/wineuser/vs_BuildTools.exe --quiet --layout c:\BT2017offline --add Microsoft.VisualStudio.Workload.MSBuildTools

ENTRYPOINT ["/usr/bin/entrypoint-msvc"]
