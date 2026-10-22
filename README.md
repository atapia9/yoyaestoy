# ✋ ¡Yo ya estoy!

Botón en línea para grupos. Cada participante lo presiona al terminar una actividad; **todo el grupo recibe el aviso** y la app guarda una **bitácora de quién terminó primero** y en cuánto tiempo.

> Este material fue elaborado con asistencia de Claude (Anthropic) y revisado por [nombre].

## Qué hace

- **Registro con nombre**: cada participante escribe su nombre al entrar a la sala; desde ahí se lleva su tiempo.
- **Botón rojo “¿Cómo Vamos?”**: al presionarlo se pone verde con “Yo Ya Estoy ! ! !” y se registra el lugar y el tiempo desde que inició la ronda (lo mide el servidor o el moderador, no el teléfono de cada quien). También se puede usar Enter o la barra espaciadora. Se puede escribir la respuesta antes de presionar.
- **Notificación al grupo**: aviso en pantalla, sonido, vibración en móvil y notificación del sistema si la pestaña está en segundo plano.
- **Bitácora** en vivo de cada ronda (lugar, nombre, tiempo, respuesta, validación) y descarga en **CSV** para Excel.
- **Ventana de validación**: el moderador marca cada respuesta como ✓ correcta o ✗ incorrecta (se abre sola al cerrar la ronda y se puede corregir después).
- **Reinicio**: “Reiniciar ronda” (borra los registros de la ronda y el cronómetro vuelve a cero) y “Reiniciar juego” (borra todo).
- **Resumen de hasta 10 rondas** y **clasificación** de los más rápidos:
  - Ganar la ronda (primera respuesta correcta por tiempo): **3 pts**.
  - Otra respuesta correcta: **1 pt**.
  - Empates: más rondas ganadas → más correctas → menor tiempo promedio de respuestas correctas → menor tiempo promedio general.
- Las respuestas de los demás se ocultan a los participantes mientras la ronda está abierta y se revelan al cerrarla.

## Dos formas de usarla

| | **Modo servidor (Node.js)** | **Modo P2P (GitHub Pages)** |
|---|---|---|
| Dónde corre | `npm start` en tu computadora o en un hosting de Node (Render, Railway, Codespaces…) | Página estática en GitHub Pages, sin servidor propio |
| Cómo se conectan | Socket.IO al servidor | El navegador del moderador guarda la sala; los participantes se conectan a él con WebRTC (PeerJS) |
| Requisito | Que el servidor esté encendido | Que el moderador **mantenga abierta su pestaña** |
| Recomendado para | Grupos grandes o redes escolares restrictivas | Uso rápido sin instalar nada |

La app elige el modo sola: si la página la sirve el servidor Node.js usa **modo servidor**; si es estática (GitHub Pages) usa **modo P2P**. Se puede forzar con `?modo=p2p` o `?modo=servidor` en la URL.

### Opción 1 · En tu computadora (modo servidor)

Requiere [Node.js](https://nodejs.org) 18 o más reciente.

```bash
npm install
```

```bash
npm start
```

Abre http://localhost:3000. La terminal también muestra la dirección para tu red local (por ejemplo `http://192.168.1.20:3000`): compártela con quienes estén en el mismo Wi‑Fi.

Pruebas automáticas:

```bash
npm test
```

### Opción 2 · Publicar en GitHub Pages (modo P2P)

1. Crea un repositorio en GitHub y sube este proyecto a la rama `main`:
   ```bash
   git init && git add . && git commit -m "¡Yo ya estoy!" && git branch -M main
   ```
   ```bash
   git remote add origin https://github.com/TU_USUARIO/yoyaestoy.git && git push -u origin main
   ```
2. En el repositorio: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. El workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml) corre las pruebas y publica la carpeta `public/`. Al terminar, la app queda en `https://TU_USUARIO.github.io/yoyaestoy/`.

Notas del modo P2P:
- Usa el servicio público gratuito de PeerJS solo para que los navegadores se encuentren; los datos del juego viajan directo entre navegadores.
- Si el moderador recarga la página, la sala se recupera con **“Reanudar sala”** (queda guardada en su navegador) y los participantes se reconectan solos.
- En algunas redes muy restrictivas (firewalls escolares o corporativos, VPN) WebRTC puede fallar: la app avisa “la red no permitió la conexión directa”. En ese caso usa otra red o el modo servidor (opciones 1 o 3).

### Opción 3 · Interfaz en GitHub Pages + servidor Node.js en la nube

Despliega `server.js` en un hosting de Node (por ejemplo Render: *New Web Service* → comando de inicio `npm start`) y escribe su dirección en [`public/js/config.js`](public/js/config.js):

```js
export default { serverUrl: 'https://tu-app.onrender.com' };
```

También puedes probarlo sin editar nada con `?servidor=https://tu-app.onrender.com` en la URL. Para limitar qué páginas pueden conectarse, define la variable de entorno `CORS_ORIGIN=https://TU_USUARIO.github.io` en el servidor.

## Cómo se juega

1. **Moderador**: “Crear sala” → comparte el código o el enlace (botón “Copiar enlace”).
2. **Participantes**: escriben su nombre y el código → “Entrar a la sala”.
3. El moderador escribe la actividad (opcional) y presiona **▶ Iniciar ronda**.
4. Cada participante presiona el botón rojo **¿Cómo Vamos?** al terminar (se pone verde: **Yo Ya Estoy ! ! !**). Todos ven el aviso “✅ Ana ya terminó · #1 · 12.34 s”.
5. El moderador presiona **⏹ Cerrar ronda** y valida las respuestas en la ventana de validación.
6. Repite hasta 10 rondas. Descarga la bitácora con **⬇ Bitácora CSV**.

## Estructura

```
server.js               Servidor Express + Socket.IO
public/                 Lo que se publica en GitHub Pages
  index.html
  css/styles.css
  js/game.js            Reglas: rondas, tiempos, validación, clasificación, CSV
  js/room.js            Acciones permitidas para moderador y participantes
  js/transport.js       Conexión: Socket.IO (servidor) o PeerJS (P2P)
  js/config.js          URL opcional de un servidor externo
  js/app.js             Interfaz
test/game.test.js       Pruebas (node --test)
.github/workflows/      Pruebas en cada cambio y publicación en Pages
```

## Licencia

MIT
