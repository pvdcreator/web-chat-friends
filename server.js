const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let usuariosConectados = [];
let usuariosRegistrados = []; 
let historias = [];
let mensajesPrivados = {}; 
let accesosLog = [];

io.on('connection', (socket) => {
    console.log('Nuevo usuario conectado:', socket.id);

    // Registro flexible que acepta cualquier usuario al instante
    socket.on('auth-registro', (data) => {
        let user = usuariosRegistrados.find(u => u.username === data.username);
        if (!user) {
            user = {
                id: socket.id,
                username: data.username,
                password: data.password,
                nombre: data.nombre || data.username,
                bio: data.bio || 'Conectado en Web Chat Friends',
                foto: data.fotoVerificada || 'https://api.dicebear.com/7.x/bottts/png?seed=' + data.username,
                rol: usuariosRegistrados.length === 0 ? 'admin' : 'usuario'
            };
            usuariosRegistrados.push(user);
        } else {
            user.id = socket.id;
        }
        socket.emit('auth-exito', user);
    });

    // Login flexible (permite entrar con cualquier usuario y contraseña de una)
    socket.on('auth-login', (data) => {
        let user = usuariosRegistrados.find(u => u.username === data.username);
        
        if (!user) {
            user = {
                id: socket.id,
                username: data.username,
                password: data.password || '123456',
                nombre: data.username,
                bio: 'Usuario conectado',
                foto: 'https://api.dicebear.com/7.x/bottts/png?seed=' + data.username,
                rol: usuariosRegistrados.length === 0 ? 'admin' : 'usuario'
            };
            usuariosRegistrados.push(user);
        } else {
            user.id = socket.id;
        }
        
        socket.emit('auth-exito', user);
    });

    // Conexión al feed principal
    socket.on('conectar-usuario', (usuario) => {
        accesosLog.push({
            username: usuario.username,
            ip: socket.handshake.address,
            dispositivo: socket.handshake.headers['user-agent'] || 'Desconocido',
            fecha: new Date().toLocaleString()
        });

        usuariosConectados = usuariosConectados.filter(u => u.username !== usuario.username);
        usuario.id = socket.id;
        usuariosConectados.push(usuario);

        io.emit('feed-perfiles', usuariosConectados);
        io.emit('usuarios_online', usuariosConectados.length);
        socket.emit('cargar-historias', historias);
    });

    // Mensajería de texto privada 1 a 1
    socket.on('enviar-mensaje-privado', (data) => {
        const remitenteId = socket.id;
        const receptorId = data.receptorId;
        const chatKey = [remitenteId, receptorId].sort().join('_');

        if (!mensajesPrivados[chatKey]) {
            mensajesPrivados[chatKey] = [];
        }

        const nuevoMensaje = {
            remitenteId,
            texto: data.texto,
            media: data.media,
            tipo: data.tipo,
            hora: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        mensajesPrivados[chatKey].push(nuevoMensaje);

        io.to(receptorId).emit('mensaje-privado-recibido', { mensaje: nuevoMensaje, remitente: usuariosConectados.find(u => u.id === remitenteId) });
        socket.emit('mensaje-privado-recibido', { mensaje: nuevoMensaje, remitente: usuariosConectados.find(u => u.id === remitenteId) });
    });

    socket.on('cargar-chat-privado', (otroId) => {
        const chatKey = [socket.id, otroId].sort().join('_');
        const mensajes = mensajesPrivados[chatKey] || [];
        socket.emit('historial-chat-privado', { mensajes });
    });

    // Eventos generales para fotos, audios y notificaciones del chat global
    socket.on('enviar_foto', (data) => {
        io.emit('recibir_foto', data);
        io.emit('recibir_mensaje');
    });

    socket.on('enviar_audio', (data) => {
        io.emit('recibir_audio', data);
        io.emit('recibir_mensaje');
    });

    socket.on('typing', (usuario) => {
        socket.broadcast.emit('user_typing', usuario);
    });

    socket.on('stop_typing', () => {
        socket.broadcast.emit('user_stop_typing');
    });

    socket.on('enviar_reaccion', (data) => {
        io.emit('recibir_reaccion', data);
    });

    // Historias
    socket.on('subir-historia', (data) => {
        const autor = usuariosConectados.find(u => u.id === socket.id);
        if (!autor) return;

        const nuevaHistoria = {
            id: Date.now(),
            imagen: data.imagen,
            pie: data.pie,
            autorNombre: autor.nombre,
            autorFoto: autor.foto
        };

        historias.unshift(nuevaHistoria);
        io.emit('nueva-historia', nuevaHistoria);
    });

    // Panel Admin
    socket.on('admin-solicitar-datos', () => {
        socket.emit('admin-datos', { accesos: accesosLog });
    });

    // Desconexión
    socket.on('disconnect', () => {
        usuariosConectados = usuariosConectados.filter(u => u.id !== socket.id);
        io.emit('feed-perfiles', usuariosConectados);
        io.emit('usuarios_online', usuariosConectados.length);
        console.log('Usuario desconectado:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});