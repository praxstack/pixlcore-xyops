#!/usr/bin/env node

// xyOps Server - Main entry point
// Copyright (c) 2019 - 2026 PixlCore LLC
// Released under the BSD 3-Clause License.
// See the LICENSE.md file in this repository.

// Check if Node.js version is older than v22.12.0
// (First version that supports fs.glob, path.matchesGlob, and require-ESM)
var node_version = process.version.match(/^v?(\d+)\.(\d+)/);
var node_major = node_version ? parseInt(node_version[1], 10) : 0;
var node_minor = node_version ? parseInt(node_version[2], 10) : 0;
var node_too_old = node_version && ((node_major < 22) || ((node_major === 22) && (node_minor < 12)));

if (node_too_old && !process.env['XYOPS_OLD']) {
	console.error("\nERROR: You are using an incompatible version of Node.js (" + process.version + ").  xyOps requires v22.12.0 or later.  Instructions: https://nodejs.org/en/download/package-manager\n");
	process.exit(1);
}

var Echo = require('./echo.js');

// chdir to the proper server root dir
process.chdir( require('path').dirname( __dirname ) );

// load pixl-server
var server = require('./loader.js');

server.on('init', function() {
	// setup fancy echo / repl system, if enabled
	Echo.setup(server);
});

server.startup( function() {
	// server startup complete
	process.title = server.__name + ' Server';
} );
