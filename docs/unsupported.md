# Unsupported or Redesigned Upstream Surface

This document is the maintained ledger for JTOpen families that `js400` intentionally drops, defers, or redesigns. It exists to keep future work focused on IBM i host-server parity instead of recreating obsolete Java runtime scaffolding.

## Compatibility stance

`js400` compatibility means protocol parity, recognizable public class names where useful, and familiar IBM i concepts. It does not mean mirroring every deprecated Java package, carrying JavaBeans-era metadata, or recreating proxy and GUI layers that do not fit Node or Bun.

## Dropped and deferred upstream families

| Upstream package or family | Status | js400 outcome | Rationale |
| --- | --- | --- | --- |
| `com.ibm.as400.resource/*` | Deferred | Add thin wrappers later only if there is real demand | Upstream already deprecated it, and its list/resource abstraction is not idiomatic JavaScript. |
| `com.ibm.as400.vaccess/*` | Dropped | No port | Swing UI package with no meaningful Node/Bun equivalent. |
| `com.ibm.as400.micro/*` | Dropped | No port | J2ME-targeted code is obsolete and irrelevant to a pure JS runtime. |
| `ProxyServer.java`, `Px*.java`, `*ImplProxy.java`, `AbstractProxyImpl.java` | Dropped | Use direct host-server clients under `src/transport`, `src/auth`, `src/command`, `src/ifs`, `src/record`, `src/print`, `src/objects`, and `src/db` | Proxy and RMI layers conflict with the direct-client architecture and add maintenance without helping Node/Bun users. |
| `*ImplNative.java` families | Dropped | Fold behavior into the main JS implementation when needed | The Java runtime-mode split has no value in a single pure-JS runtime. |
| `*BeanInfo.java` | Dropped | No port | JavaBeans design-time metadata is not part of the JS API surface. |
| AWT/Swing sign-on classes, icon assets, and GIF resources | Dropped | No port | Desktop GUI assets and sign-on dialogs are outside the Node/Bun scope. |
| `javax.naming` object factory glue | Dropped | No port | Java naming integration does not map to package exports or JS module loading. |
| Packet-decoding demos and desktop packet-inspection utilities under `com.ibm.as400.util/*` | Dropped | Documentation or CLI-only tooling if demand appears | Demo and desktop utilities are not part of the supported runtime client surface. |
| `com.ibm.as400.util.servlet/*` | Dropped | No port | Java Servlet rendering is not a meaningful target for this project. |
| `com.ibm.as400.util.html/*` | Dropped | No port | Server-side Java HTML widget rendering has no Node/Bun equivalent. |
| `android/*` and Android-specific support classes | Dropped | No port | Android stubs do not contribute to the Node/Bun library. |
| `demo/*` and `examples/*` from JTOpen | Dropped | Write new JS examples instead | Example code must match the JS API shape instead of preserving Java samples. |
| `JavaApplicationCall.java`, `JavaApplicationCallThread.java`, `JavaApplicationCallBeanInfo.java` | Dropped | No port | Those classes depend on invoking Java programs on IBM i, which is outside a pure JS client. |
| `IFSJavaFile.java` and Java-IO adapter classes that only mimic local filesystem interfaces | Dropped | Use `src/ifs/IFSFile.js` and the stream classes under `src/ifs/` | A `java.io.File` compatibility layer adds confusion without extra IBM i capability. |
| Certificate utility family | Omit unless demanded | No current port | These APIs are niche and should not expand the surface area without a real use case. |
| XA resource family | Omit unless demanded | No current port | JTA/XA scaffolding is a poor fit for the current JS SQL and transaction model. |
| Commtrace GUI application | Omit unless demanded | Use `src/core/Trace.js` plus docs or CLI tooling | The supported tracing model is code-first, not a desktop GUI. |
| Java row-set wrappers | Omit unless demanded | Use `src/db/api/ResultSet.js` and JS iterables | JDBC row-set wrappers are Java-specific convenience layers. |
| License family (`License.java`, `LicenseGet*`, `LicenseRelease*`, `LicenseRetrieve*`, `LicenseBase*`) | Deferred | Revisit later if demand exists | License management is rare and not needed for the core client. |
| `module-info.java` | Dropped | Use `package.json` `exports` | JS packages use package metadata instead of JPMS descriptors. |
| `ResourceBundleLoader.java` | Dropped | Use ESM imports and local constants | Java resource-bundle loading does not belong in a JS package. |
| `Copyright.java` | Dropped | Keep metadata in `package.json` and `LICENSE` | Package metadata should live in package metadata, not source code. |
| `MRI*.java` resource bundles | Dropped as Java resources | Extract strings only when a JS module truly needs them | Porting ResourceBundle scaffolding would recreate Java-only infrastructure. |
| `PersistenceException.java` | Dropped | Use the error classes in `src/core/errors.js` | A dedicated Java exception shell adds no value over JS-native errors. |
| `AuthenticationIndicator.java` | Deferred | Not needed for core v1 client | Niche auth attribute for password special values; add if demand arises. |
| `ClusteredHashTable.java`, `ClusteredHashTableEntry.java` | Deferred | Not needed for core v1 client | Niche IBM i clustered hash table API; add if demand arises. |
| `com.ibm.as400.access.jdbcClient/*` (7 files: `ClientBlob`, `ClientClob`, `ClientXid`, `Lob`, `Main`, `ReflectionUtil`, `StringFormatUtil`) | Dropped | No port | Standalone JDBC client demo/test application, not part of the core library. |
| `AboutToolbox.java` | Dropped | No port | Desktop GUI utility for displaying Toolbox version info. |
| `AS400ClassPathOptimizer.java` | Dropped | No port | Java classpath management has no JS equivalent. |
| `BASE64Decoder.java`, `BASE64Encoder.java` | Dropped | Use `Buffer.from(str, 'base64')` and `buf.toString('base64')` | JS has native Base64 support; no port needed. |
| `UpdateACSJar.java` | Dropped | No port | Java JAR update utility, no JS equivalent or need. |
| `*ObjectFactory.java` | Dropped | No port | Java naming/JNDI object factory pattern has no JS equivalent. |
| `NativeErrorCode0100Exception.java`, `NativeException.java` | Dropped | No port | Java-native-only error handling for JNI code paths. |
| `ClassDecoupler.java` | Dropped | No port | Java class-loading decoupler, not relevant in ESM. |
| `HexReader.java`, `HexReaderInputStream.java` | Dropped | Use `Buffer.toString('hex')` | JS has native hex encoding/decoding. |
| `IntegerHashtable.java` | Dropped | Use JS `Map` | JS Map handles integer keys natively. |
| `NativeMethods.java`, `NativeVersion.java` | Dropped | No port | Java JNI native method bindings, not applicable. |
| `StoppableThread.java` | Dropped | No port | Java threading model; use `AbortSignal` instead. |
| `ToolboxWrapper.java` | Dropped | No port | Java wrapper/utility with no JS purpose. |
| `CommandLineArguments.java` | Dropped | No port | Java CLI argument parser; use JS `process.argv` or CLI library. |
| `JavaProgram.java` | Dropped | No port | Java program management on IBM i, not applicable. |
| `JVMInfo.java` | Dropped | No port | Java JVM info retrieval, not applicable. |
| `ReaderInputStream.java`, `RetryInputStream.java`, `SerializableInputStream.java`, `SerializableReader.java` | Dropped | No port | Java IO adapter classes with no JS equivalent needed. |
| `UserEnumeration.java` | Dropped | Use async iterables | Java Enumeration pattern replaced by JS async iteration. |
| `UserSpaceNativeReadWriteImpl.java`, `UserSpaceNativeReadWriteImplILE.java` | Dropped | No port | Native ILE implementations, not applicable to pure JS. |
| `package-info.java` | Dropped | No port | Java package metadata; use `package.json` instead. |
| `AS400SignonTextField.java`, `PasswordDialog.java`, `MessageDialog.java`, `AS400SignonDialogAdapter.java`, `ChangePasswordDialog.java` | Dropped | No port | AWT/Swing GUI dialogs, not applicable to Node/Bun. |
| Proxy server family (`PSConfig.java`, `PSConnection.java`, `PSConnectionListener.java`, `PSController.java`, `PSEventDispatcher.java`, `PSLoad.java`, `PSLoadBalancer.java`, `PSServerSocketContainer.java`, `PSTunnelConnection.java`, `PSTunnelController.java`, `ProxyClientConnection.java`, `ProxyConstants.java`, `ProxyException.java`, `ProxyReturnValue.java`, `TunnelProxyServer.java`) | Dropped | No port | Java RMI/proxy remoting infrastructure conflicts with pure JS direct-client architecture. |
| Archived directories (`archived/micro/`, `archived/jt400Servlet/`, `archived/androidStubs/`, `archived/demos/`) | Dropped | No port | Archived Java-specific code: J2ME, servlets, Android stubs, and Java demos. |
| `InternalMIME.java` | Dropped | Drop or merge into utility | Niche MIME type helper; not needed for core v1. |

## Renamed and internalized module map

The project keeps recognizable public names where they help, but the implementation is organized by subsystem instead of the original Java package tree.

| Upstream Java source or family | js400 target | Notes |
| --- | --- | --- |
| `AS400.java` | `src/core/AS400.js` | Session object and service cache. |
| `Trace.java` | `src/core/Trace.js` | Trace categories, dumps, and redaction live here. |
| `ProgramCall.java` | `src/command/ProgramCall.js` | Core program-call API. |
| `ServiceProgramCall.java` | `src/command/ServiceProgramCall.js` | Service program variant. |
| `CommandCall.java` | `src/command/CommandCall.js` | Command execution API. |
| `ProgramParameter.java` | `src/command/ProgramParameter.js` | Parameter descriptors and serialization. |
| `QSYSObjectPathName.java` | `src/ifs/QSYSObjectPathName.js` | Kept as a recognizable path helper. |
| `IFSFile*.java` | `src/ifs/*` | Real IFS operations stay under the IFS subsystem. |
| `DataQueue*.java` | `src/objects/data-queue.js` | Queue APIs are grouped by IBM i object concern. |
| `MessageQueue.java` | `src/objects/MessageQueue.js` | Queue object API. |
| `UserSpace.java` | `src/objects/UserSpace.js` | User-space operations. |
| `ObjectList.java`, `UserList.java`, `com.ibm.as400.access.list/*` | `src/objects/list/*` | List helpers stay with object APIs. |
| `OutputQueue.java`, `SpooledFile.java`, `Printer.java` | `src/print/*` | Print services are isolated under `src/print`. |
| `Pcml*.java` | `src/pcml/*` | Parser, document model, cache, and resources. |
| `AS400JDBC*`, `JD*`, `DB*DS` | `src/db/*` | SQL client and DRDA protocol engine. |
| `BinaryConverter.java` | `src/datatypes/BinaryConverter.js` | Low-level binary type conversion merged into datatypes. |
| `DataStream.java` | `src/transport/DataStream.js` | Base datastream class merged into transport. |
| `CADSPool.java` | `src/transport/` internals | Internal ClientAccessDataStream object pool merged into transport layer. |
| `SystemProperties.java` | `src/internal/SystemProperties.js` | System property defaults internalized. |
| `Converter.java`, `ConverterImplRemote.java` | `src/ccsid/CharConverter.js` | Converter variants are merged into one JS converter surface. |
| `ConversionMaps.java`, `NLSImplRemote.java` | `src/ccsid/registry.js` | CCSID registry and lookup tables live here. |
| `JPing.java` | `src/objects/JPing.js` | Reduced to a small JS ping utility. |
| `AS400ConnectionPool.java` | `src/compat/AS400ConnectionPool.js` over `src/internal/pool/ConnectionPool.js` | Compatibility wrapper only; the pool implementation stays outside `compat`. |
| `AS400FTP.java` | `src/compat/AS400FTP.js` | Thin compatibility placeholder only; not a full reimplementation of the old FTP family. |

## JS-native replacements

| Java-era pattern | js400 replacement | Why |
| --- | --- | --- |
| Java threads and background worker objects | `async` methods, explicit `close()`, and `AbortSignal` | Node/Bun concurrency is promise-based, not thread-object-based. |
| `Enumeration`, listener-heavy list APIs | Async iterables or explicit callbacks where justified | This keeps consumption idiomatic in modern JS. |
| `java.io.File`-style adapters over IFS | `IFSFile`, `IFSFileInputStream`, `IFSFileOutputStream`, `IFSRandomAccessFile` | The supported abstraction is an IBM i IFS client, not a fake local filesystem object. |
| RMI/proxy transport layers | Direct socket/protocol clients under `src/transport` and service subsystems | Pure JS can talk to host servers directly. |
| Java ResourceBundle and MRI loaders | Direct ESM imports and plain JS constants | Simpler runtime, fewer moving parts. |
| JDBC row-set wrappers | `ResultSet`, statement APIs, and JS objects/iterables | Keeps SQL consumption aligned with JavaScript expectations. |
| JTOpen demo code | New examples written against the JS API | Examples should teach the actual library users will install. |

## Compat policy

`src/compat/` is reserved for thin wrappers around better subsystem implementations. It must never become the real implementation of a dropped Java package. The allowed wrapper set from the current repo mapping is:

- `src/compat/AS400ConnectionPool.js`
- `src/compat/AS400FTP.js`
- `src/compat/AS400JDBCDriverUrlParser.js` if it is ever added as a thin wrapper

Anything larger belongs in the subsystem directory that owns the behavior.

## Names that must stay absent from `src/`

The following Java-only families must not appear anywhere under `src/` as filenames, class names, or comments:

- `IFSJavaFile`
- `JavaApplicationCall`
- `JavaApplicationCallThread`
- `*BeanInfo`
- `*ImplProxy`
- `*ImplNative`
- `ProxyServer`
- `Px*`

If one of those names appears, the implementation is drifting back toward unsupported Java scaffolding and should be corrected before merge.
