<div align="center">

<img src="assets/screenshot-cognitive.png" width="760" alt="Interfaz cognitiva de Neo"/>

# ⚡ Neo · Noe

## Tu sistema operativo de IA personal — que recuerda, evoluciona y es solo tuyo

*The personal AI OS that remembers, evolves, and runs entirely on your machine.*

[![tests](https://github.com/BB20260410/neo-jarvis/actions/workflows/test.yml/badge.svg)](https://github.com/BB20260410/neo-jarvis/actions/workflows/test.yml) &nbsp;
![License](https://img.shields.io/badge/License-AGPL--3.0-black) &nbsp;
![Node](https://img.shields.io/badge/Node-22.x-black) &nbsp;
![Local--First](https://img.shields.io/badge/Local--First-Privacy%20by%20default-black) &nbsp;
![Self--Evolving](https://img.shields.io/badge/%F0%9F%94%84-Self--Evolving-black)

### Dale a cada persona un compañero de IA que de verdad la entienda — y que evoluciona por sí mismo.

**🌐 [English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · Español**

</div>

---

## 🌌 Por qué Neo

La IA de hoy es inteligente, pero **olvidadiza, pasiva y vive en los servidores de otros**. Te presentas cada día y ella olvida en cuanto responde. Cierras la tapa y vuelve a ser una desconocida.

**Neo quiere ser algo distinto.**

Un compañero que te recuerda, ve tu pantalla y te escucha; un espacio de trabajo donde **un equipo** de modelos de IA lucha a tu lado en lugar de uno solo; un sistema que, mientras descansas, **reflexiona sobre sí mismo, se mejora y se vuelve mejor.**

Y es **solo tuyo**. Se ejecuta en tu propia máquina: datos, memoria y pensamiento se quedan en local. No es el cliente de un producto en la nube. Es **tu** sistema operativo de IA.

---

## ✨ Qué puede hacer Neo

> 🔄 **Evoluciona solo** — Neo reflexiona sobre su estado, define su propia dirección de mejora, **reescribe su propio código fuente**, ejecuta las pruebas y solo lo aplica tras pasar una compuerta doble-verde y la revisión de varios modelos. La IA como sistema que crece, no como herramienta congelada.

> 🧩 **Un equipo de IA, no una sola** — un cerebro principal local + un cerebro revisor + modelos potentes en la nube, repartidos por tarea y verificándose mutuamente. La alucinación de un modelo la atrapa otro al instante.

> 💾 **Nunca olvida** — memoria persistente de tres capas (base de conocimiento semántica + memoria de archivos + grafo de memoria). Te recuerda entre sesiones y trae las lecciones aprendidas a la siguiente conversación. Cuanto más lo usas, mejor te conoce.

> 🎙️👁️🤝 **Escucha, ve y toma la iniciativa** — voz local de entrada/salida, un modelo de visión que lee tu pantalla, y una proactividad *contenida*: habla en el momento oportuno en vez de saturarte.

> 🪞 **Un interior transparente** — flujo de conciencia, objetivos, expectativas y estado emocional (VAD / Espacio de Trabajo Global) todo visualizado. Puedes *ver lo que piensa*, no es una caja negra.

---

## 📸 Interfaz real

> Todas las capturas son de Neo ejecutándose en local en `http://127.0.0.1:51835`.

**Espacio de trabajo principal** — chat directo / colaboración multimodelo / desglose de proyectos / herramientas y terminal, todo en una entrada
![Espacio de trabajo](assets/screenshot-index.png)

**Vista interior** — un globo situacional 3D que muestra estado de ejecución, autochequeos, tareas y memoria de un vistazo
![Vista interior](assets/screenshot-mind.png)

---

## 🔬 La autoevolución realmente funciona

```
   Reflexiona sobre sus datos (¿qué podría mejorar?)
            │
            ▼
   Propone una dirección de forma autónoma ──► Ancla de valor: ¿hay un objetivo técnico real? ¿verificable? ¿no es solo inflar métricas?
            │
            ▼
   El modelo reescribe su propio código (prioriza mejoras de lógica pequeñas y reales)
            │
            ▼
   Compuerta doble-verde: pruebas en verde antes Y después del cambio  ──►  revierte si falla
            │
            ▼
   Revisión multimodelo ──► aplica y registra si pasa / registra con honestidad si falla
```

Un ancla de valor más un cortacircuitos anti reward-hacking evitan que genere cambios sin sentido solo para "parecer que evoluciona". No es una idea del roadmap: es un mecanismo **funcionando hoy**.

---

## 🚀 Roadmap · Hacia dónde vamos

> Lo siguiente es la **visión y los objetivos del producto**, con marcadores honestos de progreso: 🟢 hecho / 🟡 en curso / 🔵 planificado.

**Fase 1 · Un OS de IA personal vivo** 🟢
Arquitectura local-first, clúster multi-IA, memoria de tres capas, voz/visión/compañía proactiva y el bucle de autoevolución — **hecho y funcionando**.

**Fase 2 · Cada vez mejor evolucionando** 🟡
Elevar la tasa de aterrizaje y la amplitud de exploración de la autoevolución, hacer que el grafo de memoria participe de verdad en el razonamiento y ampliar las herramientas que puede invocar por sí mismo. Que Neo sea cada día un poco más fuerte.

**Fase 3 · Un copiloto multimodal sin fisuras** 🔵
Voz, visión, texto y herramientas unificados; una proactividad más inteligente (saber cuándo lo necesitas y cuándo callar); el mismo "él" continuado entre tus dispositivos.

**Visión final · Un Jarvis para todos** 🔵
Un sistema operativo de IA totalmente tuyo, que corre en tu propia máquina, te conoce mejor cuanto más lo usas y puede pensar y actuar en tu nombre. No inteligencia alquilada, sino la tuya propia.

---

## 🛠️ Stack técnico

| Capa | Elección |
|---|---|
| Backend | Node.js 22.x + Express + WebSocket, todo ES Module |
| Frontend | Web GUI nativa (sin framework pesado), empaquetable como `.app` de macOS |
| Datos | SQLite como base + búsqueda vectorial local |
| Modelos | Local vía LM Studio / Ollama (qwen, gemma, etc.); nube opcional |
| Calidad | Suite completa de pruebas + walkthrough end-to-end + compuertas de auditoría de rendimiento/salud |

---

## 🚀 Inicio rápido

**Requiere Node.js 22.x** — `npm start` pasa por un guardián de versión (`scripts/ensure-node22.mjs`) que exige Node 22 exactamente, no "22 o superior". Si tu `node` por defecto es otra versión mayor, instala Node 22 (p. ej. `nvm install 22`) o apunta `NOE_NODE_BIN` a un binario de Node 22.

```bash
# 1) Instalar dependencias
npm install --omit=dev   # solo runtime — ~210 MB en node_modules, suficiente para ejecutar el panel
# npm install            # instalación completa (desarrollo / tests) — ~850 MB+ (añade Electron, Playwright, Vitest…)

# 2) Arrancar (por defecto 127.0.0.1:51835, solo local)
npm start

# 3) Abre la URL impresa en el log de arranque — lleva tu token de owner:
#    🚀 Noe @ http://127.0.0.1:51835/?t=<owner-token>
```

> **Importante:** abre la URL exacta del log, **con la parte `?t=...`**. Abrir `http://127.0.0.1:51835` a secas carga el esqueleto de la página, pero todas las llamadas a la API devolverán 401 — el token `?t=` es lo que te autentica como owner (el frontend lo guarda en `sessionStorage`). En macOS, `npm start` desde una terminal interactiva abre automáticamente la URL correcta en el navegador. El archivo `.env` es opcional — ver [`.env.example`](.env.example).

---

## 🧭 Primera ejecución — qué esperar

- **La interfaz es actualmente principalmente en chino.** Una UI en inglés está en el roadmap; por ahora el código, los logs y este README son los puntos de entrada en inglés/español.
- **Sin modelo local ni clave de nube,** el panel arranca y puedes explorar todas las páginas, pero las respuestas del chat fallarán — Neo necesita al menos un "cerebro". El primer paso más rápido: ejecuta [LM Studio](https://lmstudio.ai) (por defecto `http://127.0.0.1:1234/v1`) u [Ollama](https://ollama.com) (por defecto `http://127.0.0.1:11434`) con un modelo local capaz, luego `cp .env.example .env` y apunta `NOE_LMSTUDIO_URL` / `NOE_OLLAMA_URL`.
- **Voz y visión necesitan servicios locales acompañantes** (un servidor Whisper STT, un VLM servido por un endpoint compatible con OpenAI). **La autoevolución está desactivada por defecto** (`NOE_SELF_EVOLUTION=1` para armarla; permanece en dry-run salvo que actives `NOE_SELF_EVOLUTION_REAL_APPLY=1`).

---

## 🎯 Nota honesta

Neo es un **proyecto personal / experimental**, con la privacidad y lo local por delante. Las capacidades **ya funcionando** (bucle de autoevolución, colaboración multi-IA, memoria de tres capas, voz/visión) funcionan de verdad; no son demos. **Las fases 2 y 3 del roadmap y la visión final son objetivos hacia los que trabajamos, aún no completos.** Lo que ves aquí es un sistema real y en crecimiento — y aquello en lo que aspira a convertirse.

---

## 📄 License

**AGPL-3.0.** Gratis para uso personal, educativo y de código abierto — si modificas Neo o lo ejecutas como servicio de red, tus cambios también deben publicarse como código abierto bajo AGPL. **Usar Neo dentro de un producto comercial de código cerrado requiere una licencia comercial aparte** — abre un issue para consultar.

**La frontera honesta entre gratis y de pago:** sin archivo de licencia, Neo funciona en el **nivel free** y el núcleo del producto es totalmente usable — chat, salas de debate, memoria de tres capas, todas las funciones de cerebro local, voz/visión y el bucle de autoevolución **no** están bloqueados por licencia. Lo que desbloquea una licencia Pro/Team de pago: **modos de sala multi-IA squad y arena**, **más de 3 servidores MCP**, **más de 3 adaptadores de sala** y **múltiples workspaces** (Team). La verificación de licencia es un archivo local firmado con Ed25519 — sin llamadas a casa, sin cuenta. Al ser código AGPL, puedes quitar esas puertas en tu propio fork; la licencia de pago existe para financiar el desarrollo y otorgar lo que AGPL no puede (uso comercial de código cerrado).

💼 **Licencia comercial** → [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)  ·  🤝 **¿Quieres contribuir?** → [CONTRIBUTING.md](CONTRIBUTING.md)

<div align="center">
<br/>
<sub>⚡ Neo · Dale a cada persona una IA que sea de verdad suya — y que evoluciona.</sub>
</div>
