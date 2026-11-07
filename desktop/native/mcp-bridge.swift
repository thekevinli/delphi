import Foundation
import Darwin

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1)
}
let args = CommandLine.arguments
// A Keychain-era launcher passes no token path until Delphi rewrites it.
if args.count == 3 { fail("Open Delphi and use Help → Set Up Delphi MCP to refresh this connection") }
if args.count < 4 { fail("Usage: delphi-mcp socket-path pairing-id token-path") }
let pairing = args[2]
// The token file is the user's own (0600, written by Delphi); the socket is too.
guard let secret = FileManager.default.contents(atPath:args[3]), let token = String(data:secret, encoding:.utf8)?.trimmingCharacters(in:.whitespacesAndNewlines), token.count == 64
else { fail("Open Delphi and use Help → Set Up Delphi MCP; the pairing token is missing") }
let fd = socket(AF_UNIX, SOCK_STREAM, 0)
guard fd >= 0 else { fail("Cannot create local socket") }
var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
let path = Array(args[1].utf8CString)
guard path.count <= MemoryLayout.size(ofValue:address.sun_path) else { fail("Socket path too long") }
withUnsafeMutableBytes(of:&address.sun_path) { buffer in for (i,byte) in path.enumerated() { buffer[i] = UInt8(bitPattern:byte) } }
let connected = withUnsafePointer(to:&address) { ptr in ptr.withMemoryRebound(to:sockaddr.self, capacity:1) { Darwin.connect(fd,$0,socklen_t(MemoryLayout<sockaddr_un>.size)) } }
guard connected == 0 else { fail("Delphi research service is not running") }
var noSigPipe:Int32 = 1
setsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&noSigPipe,socklen_t(MemoryLayout<Int32>.size))
let socketHandle = FileHandle(fileDescriptor:fd, closeOnDealloc:true)
let auth = try JSONSerialization.data(withJSONObject:["pairing":pairing,"token":token])
socketHandle.write(auth + Data([10]))
DispatchQueue.global().async {
    while true {
        let data = FileHandle.standardInput.availableData
        if data.isEmpty { Darwin.shutdown(fd,SHUT_WR); return }
        socketHandle.write(data)
    }
}
while true {
    let data = socketHandle.availableData
    if data.isEmpty { break }
    FileHandle.standardOutput.write(data)
}
