# ✋ ¡Yo ya estoy!

Botón en línea para grupos. Cada participante lo presiona al terminar una actividad; **todo el grupo recibe el aviso** y la app guarda una **bitácora de quién terminó primero** y en cuánto tiempo.

> Este material fue elaborado con asistencia de Claude (Anthropic) y revisado por Jesus Armando Tapia Gallegos.

## 👉 Úsala ahora: **[atapia9.github.io/yoyaestoy](https://atapia9.github.io/yoyaestoy/)**

No necesitas instalar nada ni crear cuenta. Funciona en computadora, tableta y celular, con cualquier navegador moderno (Chrome, Edge, Firefox o Safari).

## Primeros pasos (5 minutos)

**Si vas a moderar (docente, facilitador):**

1. Abre [atapia9.github.io/yoyaestoy](https://atapia9.github.io/yoyaestoy/) en tu computadora y presiona **Crear sala**.
2. Comparte el **código** (por ejemplo `K7M2Q`) o el enlace del botón **Copiar enlace** por chat, en el pizarrón o proyectado.
3. Espera a que aparezcan los nombres en **Participantes**.
4. Escribe la actividad (opcional) y presiona **▶ Iniciar ronda**.
5. Cuando todos terminen, presiona **⏹ Cerrar ronda** y marca ✓ / ✗ en la ventana de validación.
6. **No cierres ni recargues tu pestaña** mientras dure la actividad: en GitHub Pages la sala vive en tu navegador. Si se cierra por accidente, vuelve a abrir la página y usa **Reanudar sala**.

**Si vas a participar:**

1. Abre el enlace que te compartieron (o la página y escribe el código).
2. Escribe tu nombre y presiona **Entrar a la sala**.
3. Cuando inicie la ronda, el botón rojo **¿Cómo Vamos?** se activa. Escribe tu respuesta si te la piden y presiónalo al terminar.
4. El botón se pone verde con **Yo Ya Estoy ! ! !** y todos ven tu lugar y tu tiempo.

**Antes de usarla con tu grupo:** haz una prueba con dos dispositivos (por ejemplo tu computadora y tu celular) en la misma red que usarán los participantes.

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
| Capacidad medida | Hasta ~500 personas con respuesta menor a 1 s ([detalle](#capacidad-medida)) | Hasta ~50 personas (estimado) |
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

## Limitaciones

**Generales**
- Máximo **10 rondas** por juego. Para seguir, descarga la bitácora y usa **Reiniciar juego**.
- El tiempo se mide cuando el aviso **llega** al moderador o al servidor, así que incluye la demora de la red de cada participante (normalmente de décimas de segundo). **Diferencias menores a ~0.5 s no son confiables** para decidir un ganador.
- No hay cuentas ni contraseñas: **cualquiera con el código puede entrar** y los nombres no se verifican. El moderador no puede expulsar participantes; si alguien entra sin permiso, crea una sala nueva.
- Las respuestas escritas se limitan a 200 caracteres y los nombres a 30. La validación de respuestas es manual.
- Las notificaciones del sistema solo aparecen si el participante las activa y la pestaña está en segundo plano. En iPhone/iPad no funcionan en una pestaña normal de Safari, y la vibración no existe en iPhone. El sonido se activa después del primer toque en la página.
- En celular, si se bloquea la pantalla o se cambia de app por mucho tiempo, la conexión puede pausarse; la app intenta reconectarse sola.

**Modo P2P (GitHub Pages)**
- Depende de que el **moderador mantenga abierta su pestaña** y de que su equipo no se suspenda.
- Usa servicios públicos gratuitos de terceros (servidor de señalización de PeerJS y STUN de Google). Si no están disponibles, la sala no abre.
- Algunas redes escolares, corporativas o con VPN **bloquean WebRTC**. La app avisa “la red no permitió la conexión directa”; prueba con datos móviles o usa el modo servidor.
- Recomendado hasta ~50 personas. Con más, la conexión de subida del moderador se vuelve el cuello de botella (ver [Capacidad medida](#capacidad-medida)).

**Modo servidor (Node.js)**
- Las salas se guardan **en memoria**: se pierden si el servidor se reinicia y se borran tras 12 horas sin actividad.
- Los hostings gratuitos (como Render) “duermen” el servidor sin uso; la primera conexión puede tardar hasta un minuto.

## Capacidad medida

Prueba de carga del 21 de octubre de 2026: 10 rondas completas por escenario; cada participante usa su propia conexión y presiona en algún momento de los 3 segundos siguientes al inicio de la ronda. Todo corrió en una laptop (Intel i5 de 4 núcleos, 8 GB), sin la demora de una red real.

**Modo servidor**

| Participantes | “Registrado” (p95) | Aviso al último del grupo (p95) | Errores o desconexiones |
|---:|---:|---:|---:|
| 25 | 2 ms | 0.24 s | 0 |
| 100 | 6 ms | 0.26 s | 0 |
| 200 | 18 ms | 0.27 s | 0 |
| 300 | 40 ms | 0.29 s | 0 |
| 500 | 0.34 s | 0.54 s | 0 |
| 750 | 0.86 s | 1.25 s | 0 |
| 1000 | 4.6 s | 5.1 s | 0 |

*p95 = el 95 % de los casos tardó eso o menos.* El aviso al grupo se agrupa cada 250 ms, por eso nunca baja de ~0.25 s. En todos los escenarios el **primer lugar se asignó bien en las 10 rondas**; las únicas diferencias de orden fueron entre presiones con menos de 40 ms de diferencia.

- **Recomendado:** hasta ~500 personas. Con 750 funciona con ~1 s de demora; con 1000 llega a ~5 s.
- Un juego de 10 rondas con 500 personas envía ~1.3 GB en total desde el servidor. Revisa el límite de tráfico de tu hosting.
- Con red Wi‑Fi real y un servidor más modesto (los planes gratuitos tienen poca CPU), espera cifras menores.

**Modo P2P (estimado)**

No se pudo probar con WebRTC real. Se midió con el mismo código el trabajo del navegador del moderador, incluyendo validar todas las respuestas:

| Participantes | CPU del moderador | Subida del moderador por ronda |
|---:|---:|---:|
| 25 | 1 % | 1.6 MB |
| 50 | 3 % | 9 MB |
| 100 | 14 % | 60 MB |
| 200 | 86 % | 440 MB |

Con 50 personas basta una conexión normal. Con 100 se necesita una subida estable de ~5 Mbps durante toda la ronda.

**Repetir la prueba**

```bash
node scripts/prueba-carga.js --n 25,100,300 --rondas 10 --spread 3000
```

```bash
node scripts/costo-p2p.js --n 25,50,100
```

Antes de la optimización (estado completo enviado a todos en cada presión), el modo servidor se caía con 100 personas y P2P llegaba a su límite con ~25.

## Privacidad y datos

- No hay registro de usuarios, publicidad ni analítica.
- Se guardan solo el **nombre** que cada quien escribe, sus **tiempos** y sus **respuestas**.
- En modo P2P esos datos viven en el navegador del moderador (almacenamiento local) y viajan directo entre navegadores. Los servicios de PeerJS y STUN ven datos técnicos de conexión, como la dirección IP.
- En modo servidor viven en la memoria del servidor que tú controlas.
- La bitácora CSV se descarga solo en el equipo del moderador.
- **Recomendación:** usen nombres de pila o alias y no escriban datos personales o sensibles en las respuestas. Si los participantes son menores de edad, sigue las políticas de tu institución.

## Aviso

- Es una herramienta educativa y de dinámica de grupo, **no un sistema de evaluación oficial**. No la uses como única evidencia para calificaciones, exámenes o decisiones importantes.
- Se ofrece **“tal cual”, sin garantías** de disponibilidad, exactitud de tiempos ni funcionamiento en todas las redes y dispositivos (ver [Licencia](#licencia)).
- Quien modera es responsable de informar a los participantes cómo se usan sus datos y de revisar los resultados.
- Este proyecto fue desarrollado con asistencia de inteligencia artificial (Claude, de Anthropic) y revisado por Jesus Armando Tapia Gallegos.

## Problemas frecuentes

| Problema | Qué hacer |
|---|---|
| “No se encontró la sala” | Revisa el código y que el moderador tenga su pestaña abierta. |
| “La red no permitió la conexión directa” | La red bloquea WebRTC: usa datos móviles, otra red o el modo servidor. |
| “El nombre ya está en uso” | Otra persona usa ese nombre: agrega tu apellido o una inicial. |
| El botón no se activa | El moderador todavía no inicia la ronda, o ya presionaste en esta ronda. |
| El moderador recargó la página | Presiona **Reanudar sala**; los participantes se reconectan solos en unos segundos. |
| No suena ni llegan notificaciones | Toca la página una vez, revisa el volumen y presiona **🔔 Activar notificaciones**. |

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
test/                   Pruebas (node --test)
scripts/                Prueba de carga y estimación del modo P2P
.github/workflows/      Pruebas en cada cambio y publicación en Pages
```

## Licencia

MIT
