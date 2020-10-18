const dgram = require('dgram')
var {createServer, Socket, isIP} = require('net')
var dns = require('dns')
var util = require('util')
var Parser = require('./socks.parser')
var ip6addr = require('ip6addr')
var WebSocket = require('ws')
var WebSocketServer = require('ws').Server
const http = require('http')

var UDP_TIMEOUT = 330 * 1000 // clear stale listeners so we don't run out of ports,
  // must be longer than any typical client timeout, maybe the map takes too long to load?
  // longer than server HEARTBEAT_MSEC

var svc_strings = [
	"svc_bad",
	"svc_nop",
	"svc_gamestate",
	"svc_configstring",
	"svc_baseline",	
	"svc_serverCommand",
	"svc_download",
	"svc_snapshot",
	"svc_EOF",
	"svc_voipSpeex", // ioq3 extension
	"svc_voipOpus",  // ioq3 extension
	null, // 11
	null, // 12
	null, // 13
	null, // 14
	null, // 15
	"svc_multiview",  // 1.32e multiview extension
	"svc_zcmd",       // LZ-compressed version of svc_serverCommand
]

var MAX_STRING_CHARS = 8192
var MAX_PACKETLEN = 1400
var buffer

/*
typedef struct {
	qboolean	allowoverflow	// if false, do a Com_Error
	qboolean	overflowed		// set to true if the buffer size failed (with allowoverflow set)
	qboolean	oob			// raw out-of-band operation, no static huffman encoding/decoding
	byte	*data
	int		maxsize
	int		maxbits			// maxsize in bits, for overflow checks
	int		cursize
	int		readcount
	int		bit				// for bitwise reads and writes
} msg_t
*/

function readBits(m, offset, bits = 8) {
  var value = 0
  var nbits = bits & 7
  var sym = Huffman.allocate(new Int32Array(1), 'i32', 1)
  var bitIndex = offset
  m.forEach((c,i) => Huffman.HEAP8[buffer+i] = c)
  if ( nbits )
  {
    for ( i = 0; i < nbits; i++ ) {
      value |= Huffman._HuffmanGetBit( buffer, bitIndex ) << i
      bitIndex++
    }
    bits -= nbits
  }
  if ( bits )
  {
    for ( i = 0; i < bits; i += 8 )
    {
      bitIndex += Huffman._HuffmanGetSymbol( sym, buffer, bitIndex )
      value |= ( Huffman.getValue(sym) << (i+nbits) )
    }
  }
  return [bitIndex, value]
}

var ATYP = {
  IPv4: 0x01,
  NAME: 0x03,
  IPv6: 0x04
}
var REP = {
  SUCCESS: 0x00,
  GENFAIL: 0x01,
  DISALLOW: 0x02,
  NETUNREACH: 0x03,
  HOSTUNREACH: 0x04,
  CONNREFUSED: 0x05,
  TTLEXPIRED: 0x06,
  CMDUNSUPP: 0x07,
  ATYPUNSUPP: 0x08
}

var BUF_AUTH_NO_ACCEPT = Buffer.from([0x05, 0xFF]),
    BUF_REP_INTR_SUCCESS = Buffer.from([0x05,
                                       REP.SUCCESS,
                                       0x00,
                                       0x01,
                                       0x00, 0x00, 0x00, 0x00,
                                       0x00, 0x00]),
    BUF_REP_DISALLOW = Buffer.from([0x05, REP.DISALLOW]),
    BUF_REP_CMDUNSUPP = Buffer.from([0x05, REP.CMDUNSUPP])

function Server(opts) {
  if (!(this instanceof Server))
    return new Server()

  var self = this
	this._forwardIP = (opts || {}).proxy || ''
  this._slaves = (opts || {}).slaves || []
  this._listeners = {}
  this._receivers = {}
  this._directConnects = {}
  this._timeouts = {}
  this._dnsLookup = {}
  this._debug = true
  this._auths = []
  this._connections = 0
  this.maxConnections = Infinity
  setInterval(() => {
    Object.keys(this._timeouts).forEach(k => {
      if(this._timeouts[k] < Date.now() - UDP_TIMEOUT)
        self._timeoutUDP(k)
    })
  }, 100)
}

Server.prototype._onErrorNoop = function(err) {
  if(!(err.code && err.code.includes('EADDRINUSE')))
    console.log(err)
}

process.on('uncaughtException', Server.prototype._onErrorNoop)
process.on('unhandledRejection', Server.prototype._onErrorNoop)

var Huffman = require('../lib/huffman.js')
Huffman.onRuntimeInitialized = () => {
  Huffman['_MSG_initHuffman']()
  buffer = Huffman.allocate(new Int8Array(MAX_PACKETLEN), 'i8', 1)
  process.on('uncaughtException', Server.prototype._onErrorNoop)
	process.on('unhandledRejection', Server.prototype._onErrorNoop)

}

Server.prototype._onClose = function (socket, onData, onEnd) {
  console.error('Closing ', socket._socket.remoteAddress, ':', socket._socket.remotePort)
  socket.off('data', onData)
  socket.off('message', onData)
	/*
  if (socket.dstSock) {
		try {
			if(typeof socket.dstSock.end == 'function')
	      socket.dstSock.end()
	    else if(typeof socket.dstSock.close == 'function')
	      socket.dstSock.close()
		} catch(err) {
			if(!err.code || !err.code.includes('ERR_SOCKET_DGRAM_NOT_RUNNING'))
				throw err
		}
		delete socket.dstSock
		delete socket.dstPort
  }
	if(socket._socket.writable) {
    socket.on('data', onData)
    socket.on('message', onData)
  }
	*/
}

Server.prototype._onParseError = function(socket, onData, onEnd, err) {
  console.log('Parse error ', err)
  socket.off('data', onData)
  socket.off('message', onData)
  socket.close()
}

Server.prototype._onMethods = function(parser, socket, onData, onEnd, methods) {
  var auths = this._auths
  parser.authed = true
  socket.off('data', onData)
  socket.off('message', onData)
  socket.send(Buffer.from([0x05, 0x00]), { binary: true })
	if(socket._socket.resume)
		socket._socket.resume()
  socket.on('data', onData)
  socket.on('message', onData)
  //socket.send(BUF_AUTH_NO_ACCEPT, { binary: true })
}

Server.prototype._onRequest = async function(socket, onData, onEnd, reqInfo) {
	var self = this
  reqInfo.srcAddr = socket._socket.remoteAddress
  reqInfo.srcPort = socket._socket.remotePort
  var intercept = false // TODO: use this for something cool
  if (intercept && !reqInfo.dstAddr.includes('0.0.0.0')) {
    socket.send(BUF_REP_INTR_SUCCESS, { binary: true })
    socket.removeListener('error', self._onErrorNoop)
    process.nextTick(function() {
      var body = 'Hello ' + reqInfo.srcAddr + '!\n\nToday is: ' + (new Date())
      socket.send([
        'HTTP/1.1 200 OK',
        'Connection: close',
        'Content-Type: text/plain',
        'Content-Length: ' + Buffer.byteLength(body),
        '',
        body
      ].join('\r\n'))
    })
    return socket
  } else {
    //console.log('Requesting', reqInfo.cmd, reqInfo.dstAddr, ':', reqInfo.dstPort)
		if(socket._socket.resume)
			socket._socket.resume()
    await this.proxyCommand.apply(this, [socket, reqInfo])
  }
}

Server.prototype.lookupDNS = async function (address) {
  var self = this
  if(typeof this._dnsLookup[address] != 'undefined')
    return this._dnsLookup[address]
  return new Promise((resolve, reject) => dns.lookup(address, function(err, dstIP) {
    if(err) {
      return reject(err)
    }
    if(address.localeCompare(dstIP, 'en', { sensitivity: 'base' }) > 0) {
      console.log('DNS found ' + address + ' -> ' + dstIP)
			self._dnsLookup[address] = dstIP.replace('::ffff:', '')
    }
    return resolve(dstIP.replace('::ffff:', ''))
  }))
}

function NETCHAN_GENCHECKSUM(challenge, sequence) {
  return (challenge) ^ ((sequence) * (challenge))
}

function SV_ConnectionlessPacket() {
  
}

function Netchan_Process() {
  
}

function SwapLong(read, message) {
  return (message[(read>>3)+3] << 24) + (message[(read>>3)+2] << 16)
    + (message[(read>>3)+1] << 8) + message[(read>>3)]
}

function SwapShort(read, message) {
  return (message[(read>>3)+1] << 8) + message[(read>>3)]
}

function ReadString(read, message) {
  var result = ''
  do {
    read = readBits( message, read[0], 8 ) // use ReadByte so -1 is out of bounds
    var c = read[1]
    if ( c <= 0 /*c == -1 || c == 0 */ || result.length >= MAX_STRING_CHARS-1 ) {
      break
    }
    // translate all fmt spec to avoid crash bugs
    if ( c == '%' ) {
      c = '.'
    } else
    // don't allow higher ascii values
    if ( c > 127 ) {
      c = '.'
    }
    result += String.fromCharCode(c)
  } while ( true )
  return [read[0], result]
}

function SHOWNET(message, socket, client) {
  var unzipped
  if(message[0] === 255 && message[1] === 255
    && message[2] === 255 && message[3] === 255) {
    var msg = Array.from(message).map(c => c >= 20 && c <= 127 ? String.fromCharCode(c) : '.').join('')
		unzipped = [client ? 'client' : 'server', msg]
    if(msg.match(/connectResponse/ig)) {
      socket.challenge = parseInt(msg.substr(20))
      socket.compat = false
      socket.incomingSequence = 0
    } else if(msg.match(/connect/ig)) {
      //Huffman._Huffman_Decode( message, 20 * 8 )
    }
  } else {
    //console.log(Array.from(message))
    var read = 0
    var sequence = SwapLong(read, message)
    read += 32
    var fragment = (sequence >>> 31) === 1
    if(fragment) {
      sequence &= ~(1 << 31)
    }
    if(!client) {
      read += 16
    }
    var valid = false
    if(!socket.compat) {
      var checksum = SwapLong(read, message)
      read += 32
      valid = NETCHAN_GENCHECKSUM(socket.challenge, sequence) === checksum
    }
    var fragmentStart = 0
    var fragmentLength = 0
    if(fragment) {
      fragmentStart = SwapShort(read, message)
      read += 16
      fragmentLength = SwapShort(read, message)
      read += 16
    }
    if ( sequence <= socket.incomingSequence ) {
      // TODO: implement fragment and only return on final message
      //return false
    }
    socket.dropped = sequence - (socket.incomingSequence+1)
    if(fragment) {
      
    }
    socket.incomingSequence = sequence
    //console.log(message.slice(read>>3))
    // finished parsing header
    read = readBits(message, read, 32)
    var ack = read[1]
    read = readBits(message, read[0], 8)
    var cmd = read[1]
    if(cmd === 2 || cmd === 5) {
      read = readBits(message, read[0], 32)
      var seq = read[1]
    }
    switch(cmd) {
      case 2:
        /*
        while(true) {
          read = readBits(message, read[0], 8)
          switch(read[1]) {
            case 3:
              read = readBits(message, read[0], 16)
              read = ReadString(read, message)
            break
            case 4:
            break
            case 8:
            break
          }
          if(read[1] === 8 || read[1] === 0) break
        }
        */
      break
      case 5:
        read = ReadString(read, message)
      break
    }
    unzipped = [client ? 'client' : 'server', read[1]]
    //unzipped = [client ? 'client' : 'server', sequence, fragment, fragmentStart, fragmentLength, cmd, svc_strings[cmd]]
  }
  console.log(unzipped)
}

Server.prototype._onUDPMessage = function (udpLookupPort, isWebSocket, message, rinfo) {
  var self = this
  var socket = self._receivers[udpLookupPort]
  // is this valid SOCKS5 for UDP?
  var returnIP = false
  var ipv6 = ip6addr.parse(rinfo.address)
  var localbytes = ipv6.toBuffer()
  if(ipv6.kind() == 'ipv4') {
    localbytes = localbytes.slice(12)
  }
  var domain = Object.keys(this._dnsLookup)
    .filter(n => this._dnsLookup[n] == rinfo.address)[0]
  if(domain && isWebSocket) {
    domain = 'ws://' + domain
  }
  var bufrep = returnIP || !domain
    ? Buffer.alloc(4 + localbytes.length + 2 /* port */)
    : Buffer.alloc(4 + 1 /* for strlen */ + domain.length + 1 /* \0 null */ + 2)
  bufrep[0] = 0x00
  bufrep[1] = 0x00
  bufrep[2] = 0x00
  if(returnIP || !domain) {
    bufrep[3] = isWebSocket ? 0x04 : 0x01
    for (var i = 0, p = 4; i < localbytes.length; ++i, ++p) {
      bufrep[p] = localbytes[i]
    }
    bufrep.writeUInt16LE(rinfo.port, 8, true)
  } else {
    bufrep[3] = 0x03
    bufrep[4] = domain.length+1
		bufrep.write(domain, 5)
    bufrep.writeUInt16LE(rinfo.port, 5 + bufrep[4], true)
  }
  SHOWNET(message, socket, true)
  //console.log('UDP message from', rinfo.address, ':', rinfo.port, ' -> ', udpLookupPort, isWebSocket)
  socket.send(Buffer.concat([bufrep, message]), { binary: true })
	self._timeouts[udpLookupPort] = Date.now()
}

Server.prototype._timeoutUDP = function(udpLookupPort) {
  var self = this
  if(typeof self._listeners[udpLookupPort] !== 'undefined') {
    console.error('socket timeout')
    self._listeners[udpLookupPort].close()
		delete self._listeners[udpLookupPort]
  }
}

Server.prototype._onConnection = function(socket) {
	var self = this
  ++this._connections
  var parser = new Parser(socket)
      onData = parser._onData.bind(parser),
			onEnd = parser._onData.bind(parser, null),
      onError = this._onParseError.bind(this, socket, onData, onEnd), // data for unbinding, err passed in
      onMethods = this._onMethods.bind(this, parser, socket, onData, onEnd),
      onRequest = this._onRequest.bind(this, socket, onData, onEnd), // reqInfo passed in
      onClose = this._onClose.bind(this, socket, onData, onEnd)
      
  if(socket instanceof WebSocket) {
    var remoteAddr = `${socket._socket.remoteAddress}:${socket._socket.remotePort}`
    console.log(`Websocket connection ${remoteAddr}....`)
    socket.on('message', onData)
		socket.on('message', onEnd)
    socket._socket.setTimeout(0)
    socket._socket.setNoDelay(true)
    socket._socket.setKeepAlive(true)

    //if(typeof this._directConnects[remoteAddr] == 'undefined')
    //  this._directConnects[remoteAddr] = socket
  } else if (socket instanceof Socket) {
    console.log(`Net socket connection ${socket.remoteAddress}:${socket.remotePort}....`)
    socket.on('data', onData)
		socket.on('end', onEnd)
		socket.setTimeout(0)
    socket.setNoDelay(true)
    socket.setKeepAlive(true)
    socket.send = socket.write
    socket._socket = socket
    socket.close = socket.end
  } else {
    console.log('Socket type unknown!')
    socket.close()
    return
  }
  
  parser
    .on('error', onError)
    .on('ping', () => {
			var port = Object.keys(self._listeners)
				.filter(k => self._listeners[k] === socket.dstSock)[0]
			if(port) {
				self._timeouts[port] = Date.now()
			}
			socket.send(Buffer.from([0x05, 0x00]), { binary: true })
		})
    .on('methods', onMethods)
    .on('request', onRequest)

  socket.parser = parser
  socket.on('error', self._onErrorNoop)
        .on('close', onClose)
}

Server.prototype.useAuth = function(auth) {
  if (typeof auth !== 'object'
      || typeof auth.server !== 'function'
      || auth.server.length !== 2)
    throw new Error('Invalid authentication handler')
  else if (this._auths.length >= 255)
    throw new Error('Too many authentication handlers (limited to 255).')

  this._auths.push(auth)

  return this
}

Server.prototype._onSocketConnect = function(udpLookupPort, reqInfo) {
  var self = this
  var socket = self._receivers[udpLookupPort]
  if(!socket._socket.writable) return
  var ipv6 = ip6addr.parse(this._slaves[0] || socket._socket.localAddress)
  var localbytes = ipv6.toBuffer()
  if(ipv6.kind() == 'ipv4') {
    localbytes = localbytes.slice(12)
  }
  var bufrep = Buffer.alloc(6 + localbytes.length)
  bufrep[0] = 0x05
  bufrep[1] = REP.SUCCESS
  bufrep[2] = 0x00
  bufrep[3] = (ipv6.kind() == 'ipv4' ? ATYP.IPv4 : ATYP.IPv6)
  for (var i = 0, p = 4; i < localbytes.length; ++i, ++p)
    bufrep[p] = localbytes[i]
  bufrep.writeUInt16LE(socket._socket.localPort, p, true)
  socket.send(bufrep, { binary: true })

  // do some new piping for the socket
  if(typeof socket.dstSock == 'function') {
    console.log('Starting pipe')
    socket._socket.pipe(socket.dstSock)
    socket.dstSock.pipe(socket._socket)
  } else {
    console.log('Starting messages ' + ipv6.kind(), socket._socket.localPort)
    socket.send(bufrep, { binary: true })
  }
}

Server.prototype._onProxyError = function(udpLookupPort, err) {
  var socket = this._receivers[udpLookupPort]
  console.log(err)
  if(!socket._socket.writable) return
  var errbuf = Buffer.from([0x05, REP.GENFAIL])
  if (err.code) {
    switch (err.code) {
      case 'ENOENT':
      case 'ENOTFOUND':
      case 'ETIMEDOUT':
      case 'EHOSTUNREACH':
        errbuf[1] = REP.HOSTUNREACH
      break
      case 'ENETUNREACH':
        errbuf[1] = REP.NETUNREACH
      break
      case 'ECONNREFUSED':
        errbuf[1] = REP.CONNREFUSED
      break
    }
  }
  socket.send(errbuf, { binary: true })
}

Server.prototype.tryBindPort = async function(reqInfo) {
  var self = this
  var onUDPMessage = this._onUDPMessage.bind(self, reqInfo.dstPort, false /* not websocket */)
  for(var i = 0; i < 10; i++) {
    try {
      var fail = false
      var portLeft = Math.round(Math.random() * 50) * 1000 + 5000
      var portRight = reqInfo.dstPort & 0xfff
      const listener = dgram.createSocket('udp4')
      await new Promise((resolve, reject) => listener
        .on('listening', resolve)
        .on('close', () => {
          delete this._listeners[reqInfo.dstPort]
        })
        .on('error', reject)
        .on('message', onUDPMessage)
        .bind(portLeft + portRight, reqInfo.dstAddr || '0.0.0.0'))
      console.log('Starting listener ', reqInfo.dstPort, ' -> ', portLeft + portRight)
      // TODO: fix this, port will be the same for every client
      //   client needs to request the random port we assign
      self._listeners[reqInfo.dstPort] = listener
      self._timeouts[reqInfo.dstPort] = Date.now()
      return listener
    } catch(e) {
      if(!e.code.includes('EADDRINUSE')) throw e
    }
  }
  throw new Error('Failed to start UDP listener.')
}

Server.prototype.websockify = async function (reqInfo, realPort) {
  var self = this
  var onUDPMessage = self._onUDPMessage.bind(self, reqInfo.dstPort, true)
  var onError = this._onProxyError.bind(self, reqInfo.dstPort)
  var httpServer = http.createServer()
  var wss = new WebSocketServer({server: httpServer})
  // socket was connected from outside websocket connection
  wss.on('connection', async function(ws, req) {
		var dstIP = await self.lookupDNS(req.socket.remoteAddress || '0.0.0.0')
    var remoteAddr = dstIP+':'+req.socket.remotePort
    console.log('Direct connect from ' + remoteAddr)
    ws.on('message', (msg) => onUDPMessage(Buffer.from(msg), {
      address: dstIP, port: req.socket.remotePort
    }))
      .on('error', self._onErrorNoop)
      .on('close', () => delete self._directConnects[remoteAddr])
    self._directConnects[remoteAddr] = ws
  })
  self._listeners[reqInfo.dstPort].on('close', () => {
    wss.close()
  })
  await new Promise(resolve => {
    try {
      httpServer.on('error', self._onErrorNoop)
      httpServer.listen(realPort, reqInfo.dstAddr, resolve)
        .on('error', self._onErrorNoop)
    } catch (e) {
      console.log(e.message)
    }
    resolve()
  })
}

Server.prototype.websocketRequest = async function (onError, onUDPMessage, onForward, reqInfo, dstIP, realPort) {
  var self = this
  //var onConnect = this._onSocketConnect.bind(this, reqInfo.dstPort, reqInfo)
  var remoteAddr = dstIP+':'+reqInfo.dstPort
  if(typeof self._directConnects[remoteAddr] == 'undefined'
    || self._directConnects[remoteAddr].readyState > 1) {

		console.log('Websocket (bound ' + realPort + ') request ' + remoteAddr)

		if(realPort) {
			var options = {
				headers: {'x-forwarded-port': realPort}
			}
			if(self._forwardIP && self._forwardIP.length > 0) {
				options.headers['x-forwarded-for'] = self._forwardIP
			}
			self._directConnects[remoteAddr] = new WebSocket(`ws://${remoteAddr}`, null, options)
		} else {
			self._directConnects[remoteAddr] = new WebSocket(`ws://${remoteAddr}`)
		}
    self._directConnects[remoteAddr]
      .on('message', onForward)
      .on('error', (err) => self._directConnects[remoteAddr]._error(err))
      .on('open', () => {
        //onConnect()
        self._directConnects[remoteAddr]._pending.forEach(d => {
          self._directConnects[remoteAddr].send(d, { binary: true })
        })
      })
      .on('close', () => delete self._directConnects[remoteAddr])
    self._directConnects[remoteAddr]._pending = [
      reqInfo.data
    ]
  } else if (self._directConnects[remoteAddr].readyState !== 1) {
    self._directConnects[remoteAddr]._pending.push(reqInfo.data)
  } else {
    self._directConnects[remoteAddr].send(reqInfo.data, { binary: true })
  }
  self._directConnects[remoteAddr]._message = onUDPMessage
  self._directConnects[remoteAddr]._error = onError
}

Server.prototype.proxyCommand = async function(socket, reqInfo) {
  var self = this
  var dstIP
  try {
    dstIP = await self.lookupDNS(reqInfo.dstAddr || '0.0.0.0')
  } catch (e) {
    console.log('DNS error:', e)
    return
  }
  try {
    var remoteAddr = dstIP+':'+reqInfo.dstPort
    if (reqInfo.cmd == Parser.CMD.UDP) {
			var onClose = () => {
				delete self._listeners[reqInfo.dstPort]
				delete socket.dstSock
				socket.close()
			}
      socket.parser.authed = true
      socket.binding = true
      self._receivers[reqInfo.dstPort] = socket
      if(typeof self._listeners[reqInfo.dstPort] == 'undefined'
        || self._listeners[reqInfo.dstPort].readyState > 1) {
        await self.tryBindPort(reqInfo)
				socket.dstSock = self._listeners[reqInfo.dstPort]
				socket.dstPort = reqInfo.dstPort
				socket.dstSock.on('close', onClose)
				socket.on('close', () => socket.dstSock.off('close', onClose))
        // TODO: make command line option --no-ws to turn this off
        await self.websockify(reqInfo, socket.dstSock.address().port)
				
        self._onSocketConnect(reqInfo.dstPort, reqInfo)
      } else if (reqInfo.dstPort) {
				socket.dstSock = self._listeners[reqInfo.dstPort]
				socket.dstPort = reqInfo.dstPort
				socket.dstSock.on('close', onClose)
				socket.on('close', () => socket.dstSock.off('close', onClose))
				
				self._onSocketConnect(reqInfo.dstPort, reqInfo)
      } else {
      }
      console.log(`${socket._socket.remoteAddress}:${socket._socket.remotePort}`, 
				'Switching to UDP listener', reqInfo.dstPort, '->', socket.dstSock.address().port)
      socket.binding = false
      //socket.dstSock.on('close', () => {
      //  socket.dstSock = null
      //  socket.close()
      //}) // if udp binding closes also close websocket
    } else if(reqInfo.cmd == Parser.CMD.BIND) {
      socket.parser.authed = true
      self._receivers[reqInfo.dstPort] = socket
      const listener = createServer()
      socket.binding = true
      socket.dstSock = listener
			socket.dstPort = reqInfo.dstPort
      listener.on('connection', () => {})
        .on('error', self._onProxyError.bind(this, reqInfo.dstPort))
        //.on('close', () => {
        //  socket.dstSock = null
        //  socket.close()
        //}) // if udp binding closes also close websocket
        .listen(reqInfo.dstPort, reqInfo.dstAddr, () => {
          socket.binding = false
					self._onSocketConnect(reqInfo.dstPort, reqInfo)
        })
    } else if(reqInfo.cmd == Parser.CMD.CONNECT) {
      if(socket.binding) {
        // wait for the previous bind command to complete before performing a connect command
        var waiting
        var waitingCount = 0
        await new Promise(resolve => {
					waiting = setInterval(() => {
	          if(!socket.binding || waitingCount > 1000) {
	            clearInterval(waiting)
	            resolve()
	          } else
							waitingCount++
        	}, 10)
				})
      }
      /*
      var remoteAddr = dstIP+':'+reqInfo.dstPort
      if(typeof self._directConnects[remoteAddr] != 'undefined') {
        console.log('Loopback connect ' + remoteAddr)
        // do loopback, send data from a proxy request to another known client
        self._directConnects[remoteAddr]._message(Buffer.from(reqInfo.data), {
          address: socket._socket.remoteAddress, port: socket._socket.remotePort
        })
        return
      }
      */
      if(socket.dstSock) {
				SHOWNET(reqInfo.data, socket, true)
        socket.dstSock.send(reqInfo.data, 0, reqInfo.data.length, reqInfo.dstPort, dstIP)
				self._timeouts[socket.dstPort || reqInfo.srcPort] = Date.now()
      } else {
        // this is a TCP ip connection with no prior bindings?
        console.log(`${socket._socket.remoteAddress}:${socket._socket.remotePort}`, 'SHOULD NEVER HIT HERE', reqInfo)
        var dstSock = new Socket()
        socket.dstSock = dstSock
				socket.dstPort = reqInfo.dstPort
				dstSock.setTimeout(0)
        dstSock.setNoDelay(true)
        dstSock.setKeepAlive(true)
				dstSock.send = dstSock.write
				dstSock._socket = dstSock
				dstSock.close = dstSock.end
        dstSock.on('error', self._onErrorNoop)
               .on('connect', self._onSocketConnect.bind(this, reqInfo.dstPort, reqInfo))
               .connect(reqInfo.dstPort, dstIP)
      }
    // special websocket piping for quakejs servers
		} else if(reqInfo.cmd == Parser.CMD.WS) {
      var port = socket.dstPort || reqInfo.srcPort
			var onForward = (msg) => {
				self._directConnects[remoteAddr]
					._message(Buffer.from(msg), {
						address: dstIP, port: reqInfo.dstPort
					})
			}
			var realPort = socket.dstSock 
				? socket.dstSock.address().port
				: null

      self._receivers[port] = socket
      SHOWNET(reqInfo.data, socket, false)
      await self.websocketRequest(
        self._onProxyError.bind(self, port),
        self._onUDPMessage.bind(self, port, true),
				onForward, reqInfo, dstIP, realPort)
							
			socket.on('close', () => {
				if(typeof self._directConnects[remoteAddr] != 'undefined'
					&& self._directConnects[remoteAddr].readyState == 1) {
					self._directConnects[remoteAddr].off('message', onForward)
					self._directConnects[remoteAddr].close()
					delete self._directConnects[remoteAddr]
				}
			})
			
    } else {
      console.error('command unsupported')
      socket.send(BUF_REP_CMDUNSUPP, { binary: true })
      socket.close()
    }
  } catch (err) {
    if(err.code && err.code.includes('ERR_SOCKET_DGRAM_NOT_RUNNING')) {
      socket.close()
    } else
      console.log('Request error:', err)
  }
}

exports.Server = Server
