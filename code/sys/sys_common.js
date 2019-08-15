var LibrarySysCommon = {
	$SYSC__deps: ['$Browser', '$FS', '$PATH', '$SYS', 'Com_Printf', 'Com_Error'],
	$SYSC: {
		cb_context_t: {
			__size__: 8,
			data: 0,
			cb: 4
		},
		startup_data_t: {
			__size__: 4100,
			gameName: 0,
			after: 4096
		},
		download_progress_data_t: {
			__size__: 8,
			loaded: 0,
			total: 4
		},
		download_complete_data_t: {
			__size__: 4,
			progress: 0,
		},
		eula: '',
		dependencies: [
			'demoq3/pak100.pk3',
			'demoq3/default.cfg',
			'qkey'
		],
		manifest: null,
		Print: function (str) {
			str = allocate(intArrayFromString(str + '\n'), 'i8', ALLOC_STACK);

			_Com_Printf(str);
		},
		Error: function (level, err) {
			if (level === 'fatal') {
				level = 0;
			} else if (level === 'drop') {
				level = 1;
			} else if (level === 'serverdisconnect') {
				level = 2;
			} else if (level === 'disconnect') {
				level = 3;
			} else if (level === 'need_cd') {
				level = 4;
			} else {
				level = 0;
			}

			err = allocate(intArrayFromString(err + '\n'), 'i8', ALLOC_STACK);
			if(!err) err = UTF8ToString(err);

			_Com_Error(level, err);
		},
		ProxyCallback: function (cb) {
			try {
				cb();
			} catch (e) {
				if (e instanceof ExitStatus) {
					return;
				}
				// TODO should we try and call back in using __Error?
				var message = _S_Malloc(e.message.length + 1);
				stringToUTF8(e.message, message, e.message.length+1);
				_Sys_ErrorDialog(message);
				throw e;
			}
		},
		GetCDN: function () {
			return UTF8ToString(_Com_GetCDN());
		},
		GetManifest: function () {
			var manifest = UTF8ToString(_Com_GetManifest());

			if (!manifest) {
				return [];
			}

			return manifest.split(' ').map(function (entry) {
				var split = entry.split('@');

				return {
					name: split[0],
					checksum: parseInt(split[1], 10),
					compressed: parseInt(split[2], 10)
				};
			});
		},
		DownloadAsset: function (asset, onprogress, onload) {
			var root = SYSC.GetCDN();
			var name = asset.name.replace(/(.+\/|)(.+?)$/, '$1' + asset.checksum + '-$2');
			var url = '://' + root + '/assets/' + name;

			SYS.DoXHR(url, {
				dataType: 'arraybuffer',
				onprogress: onprogress,
				onload: onload
			});
		},
		DownloadAssets: function (assets, onstartasset, onprogress, onendasset, callback) {
			var progress = [];

			function downloadedBytes() {
				return progress.reduce(function (a, b) { return a + b; });
			}

			function totalBytes() {
				return assets.reduce(function (a, b) { return a + b.compressed; }, 0);
			}

			function nextDownload() {
				nextDownload.pos = nextDownload.pos == undefined ? 0 : nextDownload.pos + 1;

				if (nextDownload.pos >= assets.length) {
					return callback();
				}

				var asset = assets[nextDownload.pos];

				onstartasset(asset);

				SYSC.DownloadAsset(asset, function (loaded, total) {
					progress[nextDownload.pos] = loaded;

					onprogress(downloadedBytes(), totalBytes());
				}, function (err, data) {
					if (err) return callback(err);
					SYSC.Print('Downloaded ' + asset.name);
					onendasset(asset, data, function (err) {
						if (err) return callback(err);

						setTimeout(nextDownload);
					});
				});
			}

			nextDownload();
		},
		UpdateManifest: function (callback) {
			var fs_cdn = UTF8ToString(_Cvar_VariableString(allocate(intArrayFromString('fs_cdn'), 'i8', ALLOC_STACK)));
			var url = 'http://' + fs_cdn + '/assets/manifest.json';

			function formatManifestString(manifest) {
				return manifest.map(function (entry) {
					return entry.name + '@' + entry.checksum + '@' + entry.compressed;
				}).join(' ');
			}

			SYS.DoXHR(url, {
				dataType: 'json',
				onload: function (err, manifest) {
					if (err) return callback(new Error('Failed to download and parse manifest, ' + err.message));

					var fs_manifestName = allocate(intArrayFromString('fs_manifest'), 'i8', ALLOC_STACK);
					var fs_manifest = allocate(intArrayFromString(formatManifestString(manifest)), 'i8', ALLOC_STACK);
					_Cvar_Set(fs_manifestName, fs_manifest);

					var fs_completeManifestName = allocate(intArrayFromString('fs_completeManifest'), 'i8', ALLOC_STACK);
					var fs_completeManifest = allocate(intArrayFromString(formatManifestString(manifest)), 'i8', ALLOC_STACK);
					_Cvar_Set(fs_completeManifestName, fs_completeManifest);

					return callback();
				}
			});
		},
		SavePak: function (name, buffer, callback) {
			var fs_homepath = UTF8ToString(_Cvar_VariableString(allocate(intArrayFromString('fs_homepath'), 'i8', ALLOC_STACK)));
			var localPath = PATH.join(fs_homepath, name);

			try {
				FS.mkdir(PATH.dirname(localPath), 0777);
			} catch (e) {
				if (e.errno !== ERRNO_CODES.EEXIST) {
					return callback(e);
				}
			}

			try {
				FS.writeFile(localPath, new Uint8Array(buffer), {
					encoding: 'binary', flags: 'w', canOwn: true });
			} catch (e) {
				throw e;
			}
			
			FS.syncfs(callback);
		},
		ValidateDependency: function (dependency) {
			var fs_homepath = UTF8ToString(_Cvar_VariableString(allocate(intArrayFromString('fs_homepath'), 'i8', ALLOC_STACK)));
			var localPath = PATH.join(fs_homepath, dependency.dest);
			//var crc = SYSC.CRC32File(localPath);

			//if (crc !== dependency.checksum) {
			//	return false;
			//}
			return true;
		},
		DirtyInstallers: function (callback) {
			var dependencies = [];
			var assets = SYSC.GetManifest();

			for (var j = 0; j < assets.length; j++) {
				if (SYSC.dependencies.includes(assets[j].name)) {
					dependencies.push(assets[j]);
					break;
				}
			}

			return dependencies;
		},
		ExtractInstaller: function (data, entry, callback) {
			var gunzip = new Zlib.Gunzip(data);
			var buffer = gunzip.decompress();
			var tar = new Tar(buffer);
			var buffer = tar.getContent(entry.src);

			// TODO validate buffer checksum
			SYSC.SavePak(entry.dest, buffer, function (err) {
				if (err) return callback(err);

				callback();
			});
		},
		SyncDependencies: function (callback) {
			var downloads = SYSC.DirtyInstallers(callback);

			if (!downloads.length) {
				return callback();
			}

			function isZipped(name) {
				var name = name.toLowerCase();
				return name.includes('.gz') || name.includes('.tar')
					|| name.includes('.zip') || name.includes('.run');
			}

			SYSC.DownloadAssets(downloads, function (asset) {
				SYS.LoadingDescription('loading ' + asset.name);
			}, function (loaded, total) {
				SYS.LoadingProgress(loaded / total);
			}, function (asset, data, next) {
				if(isZipped(asset.name)) {
					SYSC.ExtractInstaller(new Uint8Array(data, asset.offset), asset, next);
				} else {
					SYSC.SavePak(asset.name, data, next)
				}
			}, function (err) {
				SYS.LoadingDescription(null);

				setTimeout(function () {
					callback(err);
				});
			});
		},
		ValidatePak: function (asset) {
			var fs_homepath = UTF8ToString(_Cvar_VariableString(allocate(intArrayFromString('fs_homepath'), 'i8', ALLOC_STACK)));
			var localPath = PATH.join(fs_homepath, asset.name);
			//var crc = SYSC.CRC32File(localPath);
			return true;
			//return crc === asset.checksum;
		},
		DirtyPaks: function () {
			return SYSC.GetManifest().filter(function (asset) {
				return asset.name.indexOf('.pk3') !== -1 && !SYSC.ValidatePak(asset);
			});
		},
		SyncPaks: function (callback) {
			var downloads = SYSC.DirtyPaks();

			SYSC.DownloadAssets(downloads, function (asset) {
				SYS.LoadingDescription('loading ' + asset.name);
			}, function (loaded, total) {
				SYS.LoadingProgress(loaded / total);
			}, function (asset, data, next) {
				SYSC.SavePak(asset.name, data, next);
			}, function (err) {
				SYS.LoadingDescription(null);

				setTimeout(function () {
					callback(err);
				});
			});
		},
		FS_Startup: function (callback) {
			SYSC.UpdateManifest(function (err) {
				if (err) return callback(err);

				SYSC.SyncDependencies(function (err) {
					if (err) return callback(err);

					SYSC.SyncPaks(Browser.safeCallback(callback));
				});
			});
		},
		FS_Shutdown: function (callback) {
			callback(null);
		},
	},
	Sys_DefaultHomePath: function () {
		return 0;
	},
	Sys_RandomBytes: function (string, len) {
		return false;
	},
	Sys_GetClipboardData: function () {
		return 0;
	},
	Sys_LowPhysicalMemory: function () {
		return false;
	},
	Sys_Basename__deps: ['$PATH'],
	Sys_Basename: function (path) {
		path = UTF8ToString(path);
		path = PATH.basename(path);
		var basename = allocate(intArrayFromString(path), 'i8', ALLOC_STACK);
		return basename;
	},
	Sys_DllExtension: function () {
		return false;
	},
	Sys_Dirname__deps: ['$PATH'],
	Sys_Dirname: function (path) {
		path = UTF8ToString(path);
		path = PATH.dirname(path);
		var dirname = allocate(intArrayFromString(path), 'i8', ALLOC_STACK);
		return dirname;
	},
	Sys_Mkfifo: function (path) {
		return 0;
	},
	Sys_ListFiles__deps: ['$PATH', 'Z_Malloc', 'S_Malloc'],
	Sys_ListFiles: function (directory, ext, filter, numfiles, dironly) {
		directory = UTF8ToString(directory);
		ext = UTF8ToString(ext);
		if (ext === '/') {
			ext = null;
			dironly = true;
		}

		// TODO support filter
		
		var contents;
		try {
			contents = FS.readdir(directory);
		} catch (e) {
			SAFE_HEAP_STORE(((numfiles)|0), ((0)|0), 4);
			return null;
		}

		var matches = [];
		for (var i = 0; i < contents.length; i++) {
			var name = contents[i];
			var stat = FS.stat(PATH.join(directory, name));

			if (dironly && !FS.isDir(stat.mode)) {
				continue;
			}

			if ((!ext || name.lastIndexOf(ext) === (name.length - ext.length))) {
				matches.push(name);
			}
		}

		{{{ makeSetValue('numfiles', '0', 'matches.length', 'i32') }}};

		if (!matches.length) {
			return null;
		}

		// return a copy of the match list
		var list = _Z_Malloc((matches.length + 1) * 4);

		var i;
		for (i = 0; i < matches.length; i++) {
			var filename = _S_Malloc(matches[i].length + 1);

			stringToUTF8(matches[i], filename, matches[i].length+1);

			// write the string's pointer back to the main array
			{{{ makeSetValue('list', 'i*4', 'filename', 'i32') }}};
		}

		// add a NULL terminator to the list
		{{{ makeSetValue('list', 'i*4', '0', 'i32') }}};

		return list;
	},
	Sys_FreeFileList__deps: ['Z_Free'],
	Sys_FreeFileList: function (list) {
		if (!list) {
			return;
		}

		var ptr;
		for (var i = 0; (ptr = ((SAFE_HEAP_LOAD((((list)+(i*4))|0), 4, 0))|0)); i++) {
			_Z_Free(ptr);
		}

		_Z_Free(list);
	},
	Sys_FOpen: function (ospath, mode) {
		try {
			return FS.open(UTF8ToString(ospath),
						   UTF8ToString(mode).replace('b', ''));
		} catch (e) {
			// short for fstat check in sys_unix.c!!!
			if(e.code === 'ENOENT') {
				return 0;
			}
			throw e;
		}
	},
	Sys_Mkdir: function (directory) {
		directory = UTF8ToString(directory);
		try {
			FS.mkdir(directory, 0777);
		} catch (e) {
			if (!(e instanceof FS.ErrnoError)) {
				SYSC.Error('drop', e.message);
			}
			return e.errno === ERRNO_CODES.EEXIST;
		}
		return true;
	},
	Sys_Cwd: function () {
		var cwd = allocate(intArrayFromString(FS.cwd()), 'i8', ALLOC_STACK);
		return cwd;
	},
	Sys_Sleep: function () {
	},
	Sys_SetEnv: function (name, value) {
		name = UTF8ToString(name);
		value = UTF8ToString(value);
	},
	Sys_PID: function () {
		return 0;
	},
	Sys_PIDIsRunning: function (pid) {
		return 1;
	}
};

autoAddDeps(LibrarySysCommon, '$SYSC');
mergeInto(LibraryManager.library, LibrarySysCommon);
