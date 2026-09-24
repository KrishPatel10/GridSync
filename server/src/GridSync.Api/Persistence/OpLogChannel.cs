using System.Threading.Channels;

namespace GridSync.Api.Persistence;

/// <summary>
/// The write-behind queue between the hub and the database: <see cref="Enqueue"/> is called from
/// <c>SheetHub.ApplyOps</c> and returns immediately (a plain in-memory write, no I/O), so accepting
/// an edit never waits on the database. <see cref="OpLogPersistenceService"/> is the only reader,
/// and does the actual, batched database writes off to the side.
///
/// This is a real durability trade-off, not a free lunch: an edit is acknowledged to the client (it
/// wins the merge and gets broadcast) before it is durably stored. If the process crashes in the
/// narrow window between accepting an op and the background service's next flush, that op is lost
/// from the log, even though a client believed it had been accepted. The channel is unbounded and
/// the flush interval is short (see OpLogPersistenceService), which keeps that window small, but it
/// is not zero. A synchronous write per op would close the window entirely at the cost of every
/// edit waiting on a database round trip; write-behind is the brief's explicit choice, and this is
/// the honest cost of it.
/// </summary>
public sealed class OpLogChannel
{
    private readonly Channel<OpLogEntry> _channel = Channel.CreateUnbounded<OpLogEntry>(
        new UnboundedChannelOptions { SingleReader = true, SingleWriter = false });

    public ChannelReader<OpLogEntry> Reader => _channel.Reader;

    /// <summary>Queues an accepted op for the background writer. Never blocks and never throws.</summary>
    public void Enqueue(string sheetId, Core.CellOp op) => _channel.Writer.TryWrite(SheetRestorer.ToLogEntry(sheetId, op));
}
