// Dedicated localhost child process. Diagnostics travel over IPC, never HTTP.
const { server, roomDiagnostics } = await import(process.env.OPERAND_SERVER_MODULE || '../server.js');
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.send({ url: `http://127.0.0.1:${server.address().port}` });
process.on('message', (message) => {
  if (message === 'metrics') {
    global.gc?.();
    process.send({ metrics: { ...roomDiagnostics(), ...process.memoryUsage() } });
  }
});
