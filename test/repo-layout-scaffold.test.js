import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const requiredFiles = [
  'src/core/AS400.js',
  'src/core/Trace.js',
  'src/core/errors.js',
  'src/core/AS400Message.js',
  'src/core/constants.js',
  'src/transport/PortMapper.js',
  'src/transport/Connection.js',
  'src/transport/DataStream.js',
  'src/transport/RequestBuilder.js',
  'src/transport/ReplyParser.js',
  'src/transport/SeedExchange.js',
  'src/transport/ServerStart.js',
  'src/transport/socket/Socks5.js',
  'src/auth/signon.js',
  'src/auth/password-encrypt.js',
  'src/auth/change-password.js',
  'src/auth/profile-token.js',
  'src/auth/constants.js',
  'src/auth/protocol/SignonExchangeReq.js',
  'src/auth/protocol/SignonExchangeRep.js',
  'src/datatypes/AS400DataType.js',
  'src/datatypes/AS400Bin1.js',
  'src/datatypes/AS400Bin2.js',
  'src/datatypes/AS400Bin4.js',
  'src/datatypes/AS400Bin8.js',
  'src/datatypes/AS400UnsignedBin1.js',
  'src/datatypes/AS400UnsignedBin2.js',
  'src/datatypes/AS400UnsignedBin4.js',
  'src/datatypes/AS400UnsignedBin8.js',
  'src/datatypes/AS400Float4.js',
  'src/datatypes/AS400Float8.js',
  'src/datatypes/AS400PackedDecimal.js',
  'src/datatypes/AS400ZonedDecimal.js',
  'src/datatypes/AS400DecFloat.js',
  'src/datatypes/AS400Text.js',
  'src/datatypes/AS400Varchar.js',
  'src/datatypes/AS400Boolean.js',
  'src/datatypes/AS400ByteArray.js',
  'src/datatypes/AS400Array.js',
  'src/datatypes/AS400Structure.js',
  'src/datatypes/BinaryConverter.js',
  'src/datatypes/datetime/AS400Date.js',
  'src/datatypes/datetime/AS400Time.js',
  'src/datatypes/datetime/AS400Timestamp.js',
  'src/datatypes/datetime/AS400DateTimeConverter.js',
  'src/ccsid/CharConverter.js',
  'src/ccsid/ConvTable.js',
  'src/ccsid/registry.js',
  'src/ccsid/bidi.js',
  'src/ccsid/generated/index.js',
  'src/command/ProgramCall.js',
  'src/command/ServiceProgramCall.js',
  'src/command/CommandCall.js',
  'src/command/ProgramParameter.js',
  'src/command/protocol/CommandReq.js',
  'src/command/protocol/CommandRep.js',
  'src/pcml/ProgramCallDocument.js',
  'src/pcml/parser.js',
  'src/pcml/model.js',
  'src/pcml/types.js',
  'src/pcml/xpcml.js',
  'src/pcml/xml.js',
  'src/pcml/cache.js',
  'src/pcml/resources/index.js',
  'src/ifs/QSYSObjectPathName.js',
  'src/ifs/IFSFile.js',
  'src/ifs/IFSFileInputStream.js',
  'src/ifs/IFSFileOutputStream.js',
  'src/ifs/IFSTextFileInputStream.js',
  'src/ifs/IFSTextFileOutputStream.js',
  'src/ifs/IFSRandomAccessFile.js',
  'src/ifs/protocol/IFSReq.js',
  'src/ifs/protocol/IFSRep.js',
  'src/objects/data-queue.js',
  'src/objects/MessageQueue.js',
  'src/objects/UserSpace.js',
  'src/objects/SaveFile.js',
  'src/objects/ValidationList.js',
  'src/objects/JPing.js',
  'src/objects/jobs/Job.js',
  'src/objects/jobs/JobList.js',
  'src/objects/jobs/JobLog.js',
  'src/objects/list/ObjectList.js',
  'src/objects/list/UserList.js',
  'src/objects/users/User.js',
  'src/objects/users/UserGroup.js',
  'src/objects/users/Permission.js',
  'src/objects/system/SystemStatus.js',
  'src/objects/system/SystemValue.js',
  'src/objects/system/DataArea.js',
  'src/objects/system/EnvironmentVariable.js',
  'src/objects/system/Subsystem.js',
  'src/objects/netserver/NetServer.js',
  'src/print/OutputQueue.js',
  'src/print/SpooledFile.js',
  'src/print/SpooledFileOutputStream.js',
  'src/print/Printer.js',
  'src/print/PrinterFile.js',
  'src/print/WriterJob.js',
  'src/print/AFPResource.js',
  'src/print/PrintObject.js',
  'src/print/PrintParameterList.js',
  'src/print/protocol/NPCPReq.js',
  'src/print/protocol/NPCPRep.js',
  'src/print/protocol/NPDataStream.js',
  'src/record/Record.js',
  'src/record/RecordFormat.js',
  'src/record/SequentialFile.js',
  'src/record/KeyedFile.js',
  'src/record/FieldDescription.js',
  'src/record/description/FileRecordDescription.js',
  'src/record/rfml/RecordFormatDocument.js',
  'src/record/protocol/DDMReq.js',
  'src/record/protocol/DDMRep.js',
  'src/record/protocol/DDMPool.js',
  'src/db/connect.js',
  'src/db/url.js',
  'src/db/properties.js',
  'src/db/engine/DbConnection.js',
  'src/db/engine/StatementManager.js',
  'src/db/engine/CursorManager.js',
  'src/db/engine/TransactionManager.js',
  'src/db/engine/PackageManager.js',
  'src/db/engine/LibraryList.js',
  'src/db/engine/SortSequence.js',
  'src/db/protocol/DBRequestDS.js',
  'src/db/protocol/DBReplyDS.js',
  'src/db/protocol/DBDescriptors.js',
  'src/db/protocol/DBLobData.js',
  'src/db/types/numeric.js',
  'src/db/types/string.js',
  'src/db/types/binary.js',
  'src/db/types/datetime.js',
  'src/db/types/lob.js',
  'src/db/types/special.js',
  'src/db/types/factory.js',
  'src/db/api/Connection.js',
  'src/db/api/Statement.js',
  'src/db/api/PreparedStatement.js',
  'src/db/api/CallableStatement.js',
  'src/db/api/ResultSet.js',
  'src/db/api/DatabaseMetaData.js',
  'src/db/api/Savepoint.js',
  'src/db/lob/Blob.js',
  'src/db/lob/Clob.js',
  'src/db/lob/SQLXML.js',
  'src/db/pool/ConnectionPool.js',
  'src/compat/AS400ConnectionPool.js',
  'src/compat/AS400FTP.js',
  'src/internal/pool/ConnectionPool.js',
  'src/internal/SystemProperties.js',
];

async function collectDirectories(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const directories = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    directories.push(fullPath);
    directories.push(...(await collectDirectories(fullPath)));
  }
  return directories;
}

describe('repo layout scaffold', () => {
  it('creates every required scaffold file', async () => {
    for (const relativePath of requiredFiles) {
      const fileInfo = await stat(path.join(ROOT, relativePath));
      assert.ok(fileInfo.isFile(), `${relativePath} must exist`);
    }
  });

  it('ensures every src subdirectory contains at least one js file', async () => {
    const directories = await collectDirectories(path.join(ROOT, 'src'));
    for (const directory of directories) {
      const entries = await readdir(directory, { withFileTypes: true });
      const hasJsFile = entries.some((entry) => entry.isFile() && entry.name.endsWith('.js'));
      assert.ok(hasJsFile, `${path.relative(ROOT, directory)} must contain a .js file`);
    }
  });

  it('exposes the db namespace exports required by the repo map', async () => {
    const db = await import('../src/db/index.js');
    assert.ok(db.connect);
    assert.ok(db.createPool);
    assert.ok(db.parseJdbcUrl);
    assert.ok(db.DbConnection);
    assert.ok(db.Statement);
    assert.ok(db.PreparedStatement);
    assert.ok(db.Savepoint);
  });
});
