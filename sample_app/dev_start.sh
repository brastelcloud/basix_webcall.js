#!/bin/bash

set -o errexit
set -o nounset
set -o pipefail

export http_proxy=
export https_proxy=
export NODE_TLS_REJECT_UNAUTHORIZED=0

npm run dev_build
node ./server.js
