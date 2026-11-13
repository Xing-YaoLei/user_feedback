#!/usr/bin/env bash
# Build and run the test suite. Kept in the repo so the check is reproducible.
set -euo pipefail
cd "$(dirname "$0")"

export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1

dotnet build BroadcastIntake.sln -c Release
dotnet run --project tests/BroadcastIntake.Tests -c Release --no-build
