import { createApp } from './app.js';
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Требуется Node.js 22 или новее');
const port = Number(process.env.PORT || 8788);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Некорректный PORT');
const server = createApp();
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Порт МНО уже занят' : 'Ошибка запуска МНО'); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log('МНО: сервер слушает 127.0.0.1:' + port));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
});
