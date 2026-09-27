const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);

// Aumentamos el buffer a 25MB para soportar fotos en alta calidad y notas de voz
const io = new Server(server, {
  maxHttpBufferSize: 25e6
});

app.use(express.static(path.join(__dirname, 'public')));

// Base de datos SQLite
const db = new sqlite3.Database('./database.sqlite', () => {
  console.log('📁 Base de datos conectada.');
});

db.serialize(() => {
  // Tabla de usuarios
  db.run(`CREATE TABLE IF NOT EXISTS usuarios (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE COLLATE NOCASE,
    password TEXT,
    nombre TEXT,
    bio TEXT,
    foto TEXT,
    verificado INTEGER DEFAULT 1,
    rol TEXT DEFAULT 'user',
    creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabla de auditoría
  db.run(`CREATE TABLE IF NOT EXISTS auditoria_accesos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id TEXT,
    username TEXT,
    ip TEXT,
    pais TEXT,
    dispositivo TEXT,
    fecha DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // El primer usuario siempre será Admin
  db.run(`UPDATE usuarios SET rol = 'admin' WHERE rowid = 1`);
});

function detectarDispositivo(userAgent = '') {
  if (/android/i.test(userAgent)) return '📱 Android';
  if (/iphone|ipad|ipod/i.test(userAgent)) return '📱 iOS (iPhone)';
  if (/windows/i.test(userAgent)) return '💻 Windows PC';
  if (/macintosh|mac os x/i.test(userAgent)) return '💻 Mac';
  return '🌐 Web';
}

function formatearIP(ip = '') {
  if (ip === '::1' || ip === '127.0.0.1' || ip.includes('::ffff:127.0.0.1')) return '127.0.0.1 (Localhost)';
  return ip.replace('::ffff:', '');
}

const usuariosOnline = new Map();
const historias = [];
const chatsPrivados = {}; // roomId -> [mensajes]

io.on('connection', (socket) => {
  const ipBruta = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  const ipCliente = formatearIP(ipBruta);
  const userAgent = socket.handshake.headers['user-agent'] || '';
  const dispositivo = detectarDispositivo(userAgent);
  const pais = (ipCliente.includes('127.0.0.1') || ipCliente.startsWith('192.168.')) ? 'Red Local' : 'Ubicación Externa';

  // REGISTRO ABIERTO CON VERIFICACIÓN FACIAL
  socket.on('auth-registro', async (datos) => {
    const { username, password, nombre, bio, fotoVerificada } = datos;

    if (!username || !password || !fotoVerificada) {
      return socket.emit('auth-error', 'Completa los campos y verifica tu rostro con la cámara.');
    }

    try {
      const passwordHash = await bcrypt.hash(password, 10);
      const userId = 'usr_' + Date.now().toString(36);

      db.get(`SELECT COUNT(*) as total FROM usuarios`, (countErr, row) => {
        const rol = (row && row.total === 0) ? 'admin' : 'user';

        db.run(
          `INSERT INTO usuarios (id, username, password, nombre, bio, foto, verificado, rol) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
          [userId, username.trim(), passwordHash, nombre.trim() || username.trim(), bio.trim() || 'Disponible en Web Chat Friends', fotoVerificada, rol],
          function (insertErr) {
            if (insertErr) return socket.emit('auth-error', 'Ese nombre de usuario ya existe.');

            db.run(`INSERT INTO auditoria_accesos (usuario_id, username, ip, pais, dispositivo) VALUES (?, ?, ?, ?, ?)`,
              [userId, username.trim(), ipCliente, pais, dispositivo]);

            socket.emit('auth-exito', {
              id: userId,
              username: username.trim(),
              nombre: nombre.trim() || username.trim(),
              bio: bio.trim() || 'Disponible en Web Chat Friends',
              foto: fotoVerificada,
              verificado: 1,
              rol: rol
            });
          }
        );
      });
    } catch (e) {
      socket.emit('auth-error', 'Error interno al procesar el registro.');
    }
  });

  // LOGIN
  socket.on('auth-login', (datos) => {
    const { username, password } = datos;
    if (!username || !password) return socket.emit('auth-error', 'Escribe usuario y contraseña.');

    db.get(`SELECT * FROM usuarios WHERE username = ?`, [username.trim()], async (err, usuario) => {
      if (err || !usuario) return socket.emit('auth-error', 'Credenciales incorrectas.');

      const valida = await bcrypt.compare(password, usuario.password);
      if (!valida) return socket.emit('auth-error', 'Credenciales incorrectas.');

      db.run(`INSERT INTO auditoria_accesos (usuario_id, username, ip, pais, dispositivo) VALUES (?, ?, ?, ?, ?)`,
        [usuario.id, usuario.username, ipCliente, pais, dispositivo]);

      socket.emit('auth-exito', {
        id: usuario.id,
        username: usuario.username,
        nombre: usuario.nombre,
        bio: usuario.bio,
        foto: usuario.foto,
        verificado: usuario.verificado,
        rol: usuario.rol
      });
    });
  });

  // CONEXIÓN AL CHAT
  socket.on('conectar-usuario', (perfil) => {
    socket.userId = perfil.id;
    socket.join(perfil.id);

    usuariosOnline.set(socket.id, {
      socketId: socket.id,
      id: perfil.id,
      username: perfil.username,
      nombre: perfil.nombre,
      bio: perfil.bio,
      foto: perfil.foto,
      verificado: perfil.verificado,
      rol: perfil.rol
    });

    db.run(`INSERT INTO auditoria_accesos (usuario_id, username, ip, pais, dispositivo) VALUES (?, ?, ?, ?, ?)`,
      [perfil.id, perfil.username || perfil.nombre, ipCliente, pais, dispositivo]);

    socket.emit('cargar-historias', historias);
    actualizarFeed();
  });

  // AUDITORÍA PARA ADMIN
  socket.on('admin-solicitar-datos', (adminId) => {
    db.get(`SELECT rol FROM usuarios WHERE id = ?`, [adminId], (err, u) => {
      if (!u || u.rol !== 'admin') return socket.emit('admin-error', 'Acceso denegado.');

      db.all(`SELECT username, ip, pais, dispositivo, fecha FROM auditoria_accesos ORDER BY id DESC LIMIT 50`, (err, accesos) => {
        socket.emit('admin-datos', { accesos: accesos || [] });
      });
    });
  });

  // HISTORIAS
  socket.on('subir-historia', (datos) => {
    const usuario = usuariosOnline.get(socket.id);
    if (!usuario || !datos.imagen) return;

    const nueva = {
      id: 'story_' + Date.now(),
      autorId: usuario.id,
      autorNombre: usuario.nombre,
      autorFoto: usuario.foto,
      imagen: datos.imagen,
      pie: datos.pie || '',
      hora: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    historias.unshift(nueva);
    io.emit('nueva-historia', nueva);
  });

  // CHAT PRIVADO MULTIMEDIA (Texto, Fotos y Notas de Voz)
  socket.on('enviar-mensaje-privado', ({ receptorId, texto, media, tipo }) => {
    const remitente = usuariosOnline.get(socket.id);
    if (!remitente) return;

    const roomId = [remitente.id, receptorId].sort().join('--');
    if (!chatsPrivados[roomId]) chatsPrivados[roomId] = [];

    const nuevoMsg = {
      id: Date.now(),
      remitenteId: remitente.id,
      receptorId: receptorId,
      tipo: tipo || 'texto', // 'texto', 'imagen', 'audio'
      texto: texto || '',
      media: media || null,
      hora: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    chatsPrivados[roomId].push(nuevoMsg);

    io.to(receptorId).to(remitente.id).emit('mensaje-privado-recibido', {
      roomId,
      mensaje: nuevoMsg,
      remitente
    });
  });

  socket.on('cargar-chat-privado', (otroId) => {
    const usuario = usuariosOnline.get(socket.id);
    if (!usuario) return;
    const roomId = [usuario.id, otroId].sort().join('--');
    socket.emit('historial-chat-privado', { roomId, mensajes: chatsPrivados[roomId] || [] });
  });

  socket.on('disconnect', () => {
    usuariosOnline.delete(socket.id);
    actualizarFeed();
  });

  function actualizarFeed() {
    const unicos = [];
    const vistos = new Set();
    for (const u of usuariosOnline.values()) {
      if (!vistos.has(u.id)) {
        vistos.add(u.id);
        unicos.push(u);
      }
    }
    io.emit('feed-perfiles', unicos);
  }
// Notificar cuando alguien escribe
    socket.on('typing', (usuario) => {
        socket.broadcast.emit('user_typing', usuario);
    });

    // Notificar cuando deja de escribir
    socket.on('stop_typing', () => {
        socket.broadcast.emit('user_stop_typing');
    });
    // Retransmitir foto a todos en el chat
    socket.on('enviar_foto', (data) => {
        io.emit('recibir_foto', data);
    });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Web Chat Friends Mobile listo en: http://localhost:${PORT}`);
});