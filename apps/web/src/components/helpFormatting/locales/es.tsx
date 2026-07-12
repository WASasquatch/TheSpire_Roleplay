/**
 * SPANISH content for the Help modal's Formatting tab (docs/I18N_PLAN.md §6,
 * glossary: packages/shared/locales/es/GLOSSARY.md).
 *
 * Drop-in locale module discovered by ../loader.ts. JSX structure, component
 * usage, and the syntax/protocol fragments (markdown markers, slash commands,
 * URLs, HTML/CSS identifiers, server-generated roll output) mirror ../en.tsx
 * exactly — only the prose translates.
 */
import { markVerified } from "@thekeep/shared";
import { parseInline } from "../../../lib/markdown.js";

const FORMATTING_ROWS: Array<{ syntax: string; example: string; note?: string }> = [
  { syntax: "**negrita**", example: "la **negrita** es firme" },
  { syntax: "__negrita__", example: "la __negrita__ es firme" },
  { syntax: "*cursiva*", example: "la *cursiva* se inclina" },
  { syntax: "_cursiva_", example: "habla _bajito_ ahora", note: "los guiones bajos requieren límites de palabra - `snake_case_var` no se pone en cursiva" },
  { syntax: "***negrita-cursiva***", example: "***las dos a la vez***" },
  { syntax: "~~tachado~~", example: "~~no es un fantasma~~" },
  { syntax: "||spoiler||", example: "el asesino es ||el mayordomo||", note: "se muestra como una caja negra; haz clic para revelarlo." },
  { syntax: "`código`", example: "presiona `Enter` para enviar" },
  { syntax: "```bloque```", example: "```\nbloque de código\nde varias líneas\n```", note: "tres acentos graves en su propia línea para un bloque preformateado. El contenido interno es literal: no se interpreta markdown, menciones ni comandos en línea." },
  { syntax: "[texto del enlace](https://url)", example: "[The Spire](https://thespire.example)", note: "solo URLs http y https - los esquemas `javascript:` se descartan en silencio" },
  { syntax: "https://url", example: "mira https://example.com para más detalles", note: "las URLs sueltas se convierten en enlaces en los límites de palabra" },
  { syntax: "![alt](https://url-de-imagen)", example: "![gato](https://example.com/cat.png)", note: "se muestra como un enlace con un botón Mostrar imagen - es opcional para que cargar la imagen no filtre tu IP al servidor que la aloja" },
  { syntax: "https://.../foto.png", example: "captura: https://example.com/screenshot.png", note: "las URLs de imagen que terminan en png/jpg/jpeg/gif/webp/svg/bmp/avif también reciben el botón Mostrar imagen" },
  { syntax: "https://youtu.be/...", example: "clip del lookbook: https://youtu.be/dQw4w9WgXcQ", note: "los enlaces de YouTube y Vimeo reciben un botón Mostrar video junto al enlace - haz clic para reproducirlo ahí mismo. Funciona con URLs de youtube.com/watch, youtu.be, youtube.com/shorts y vimeo.com" },
  { syntax: "@usuario", example: "¡gracias @sigrid!", note: "haz clic para abrir su perfil; coincide con una cuenta principal o un personaje activo" },
  { syntax: "@world:slug", example: "¿alguien para una partida en @world:ironreach?", note: "haz clic para abrir el visor del mundo; el slug es el de la URL del mundo (minúsculas + guiones)" },
  { syntax: `<font color="#hex">texto</font>`, example: `<font color="#a83232">texto rojo</font>`, note: "aplica un color puntual a un fragmento de texto. El color debe ser un hex literal de 3 o 6 dígitos; cualquier otra cosa queda como texto plano. El tema de quien lo ve ajusta el valor hacia la legibilidad si desaparecería contra su fondo de chat." },
  { syntax: `<font size="1-4">texto</font>`, example: `<font size="4">texto enorme</font>`, note: "cambia el tamaño de un fragmento de texto en cuatro pasos: 1 pequeño, 2 normal, 3 grande, 4 enorme. Los números fuera de 1-4 se ajustan al paso más cercano, y puedes combinar color y tamaño en una sola etiqueta. El menú de tamaño de la barra lo escribe por ti." },
  { syntax: "\\* escape", example: "\\*le da un coscorrón a Kaal\\*", note: "pon una barra invertida antes de cualquiera de * _ ~ | ` [ ] ( ) ! < > @ \\ para mantenerlo literal. Usa `\\@nombre` para escribir un @usuario sin mencionarlo, o `\\!cmd` para escribir el nombre del comando sin ejecutarlo." },
];

const CHECK_ROWS: Array<{ syntax: string; meaning: string; example: string }> = [
  {
    syntax: "<check> <pass>…</pass> <fail>…</fail> </check>",
    meaning:
      "Una prueba 50/50 de éxito o fallo. Escribe ambos desenlaces; la sala ve una tarjeta con el ganador y el otro queda guardado. Necesita al menos una línea de pass o fail.",
    example: "<check><pass>La cerradura cede con un clic.</pass><fail>La ganzúa se parte.</fail></check>",
  },
  {
    syntax: "<roll:NdM:DC> <pass>…</pass> <fail>…</fail> </roll>",
    meaning:
      "Como un check, pero lo decide una tirada de dados. La tirada debe igualar o superar el objetivo (DC) para pasar. Agrega un solo ajuste con +X, -X o un multiplicador x.",
    example:
      "<roll:1d20+3:12><pass>Las cuerdas se cortan limpias.</pass><fail>La cuerda apenas se marca.</fail></roll>",
  },
  {
    syntax: "!nombre  (o !nombre:extra)",
    meaning:
      "Inserta un comando personalizado en medio de una oración. Su texto aterriza ahí mismo, marcado con un ✓. Ponle una barra invertida delante (\\!nombre) para mostrarlo como texto plano.",
    example: "saluda a quien acaba de llegar !greet y sonríe",
  },
  {
    syntax: "{if:condición|entonces|si no}",
    meaning:
      'Dentro de un comando personalizado: muestra el texto de "entonces" cuando la condición tiene algo, o el de "si no" cuando está vacía. La parte del "si no" es opcional.',
    example: "{if:{target}|abraza a {target}|saluda a nadie en particular}",
  },
  {
    syntax: "{choose:a|b|c}",
    meaning:
      "Dentro de un comando personalizado: elige una de las opciones al azar. La forma corta {a|b|c} hace lo mismo.",
    example: "{choose:con calidez|con fuerza|con suavidad}",
  },
  {
    syntax: "{roll:NdM}",
    meaning:
      "Dentro de un comando personalizado: inserta un total de dados aleatorio (solo el número). Dados simples, sin ajustes de más o menos.",
    example: "¡Sacaste un {roll:1d20}!",
  },
  {
    syntax: "{=math}",
    meaning:
      "Dentro de un comando personalizado: matemática rápida con + - * / y paréntesis. Puedes anidar otras piezas adentro.",
    example: "{=10+{roll:1d20}}",
  },
];

const HTML_COMMON_TAGS: Array<{ label: string; tags: string[]; note?: string }> = [
  {
    label: "Texto",
    tags: ["b", "i", "u", "em", "strong", "s", "mark", "small", "sub", "sup", "span", "br"],
  },
  {
    label: "Estructura",
    tags: ["p", "div", "section", "article", "header", "footer", "h3", "h4", "h5", "h6", "blockquote", "pre", "hr"],
  },
  {
    label: "Listas",
    tags: ["ul", "ol", "li", "dl", "dt", "dd"],
  },
  {
    label: "Tablas",
    tags: ["table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td"],
  },
  {
    label: "Detalles / spoilers",
    tags: ["details", "summary"],
    note: "<details open> empieza desplegado.",
  },
  {
    label: "Enlaces e imágenes",
    tags: ["a", "img", "figure", "figcaption"],
    note: "Los enlaces se abren en una pestaña nueva. Las URLs de imágenes y enlaces deben ser http o https.",
  },
];

const HTML_BLOCKED = [
  "<script>",
  "<iframe> (excepto el atajo <youtube> de abajo)",
  "<form>, <input>, <button>",
  "<object>, <embed>",
  "URLs de imagen que no sean http/https",
];

const THEME_VARS: Array<{ name: string; purpose: string }> = [
  { name: "--theme-bg",     purpose: "fondo de la página" },
  { name: "--theme-panel",  purpose: "color de tarjeta / superficie" },
  { name: "--theme-border", purpose: "color de borde" },
  { name: "--theme-text",   purpose: "color del texto principal" },
  { name: "--theme-muted",  purpose: "color del texto secundario" },
  { name: "--theme-action", purpose: "color de enlaces / botones" },
  { name: "--theme-accent", purpose: "color de realce / acento" },
  { name: "--theme-system", purpose: "color de los avisos del sistema" },
];

export function FormattingHelp() {
  return (
    <div className="space-y-3 text-xs">
      <p className="text-keep-muted">
        Los mensajes de chat admiten los atajos de formato de abajo, y la
        barra de herramientas sobre el cuadro de mensaje cubre casi todos
        con un clic. Pegar desde Gmail, Docs o Word también conserva el
        formato. Las tablas quedan fuera del chat. Las páginas de perfil y
        de mundo pueden usar más (mira la sección HTML de perfiles /
        mundos, abajo).
      </p>
      <p className="text-keep-muted">
        Algunas herramientas de la barra no tienen atajo escrito. El menú
        de <b>Encabezado</b> convierte la línea actual en un encabezado
        grande 1, 2 o 3 (escribir{" "}
        <code className="font-mono text-keep-action">#</code>,{" "}
        <code className="font-mono text-keep-action">##</code> o{" "}
        <code className="font-mono text-keep-action">###</code> más un
        espacio al inicio de la línea hace lo mismo). Los tres botones de{" "}
        <b>alineación</b> llevan la línea a la izquierda, al centro o a la
        derecha. Los botones de <b>cita</b> y <b>lista</b> convierten las
        líneas en un bloque de cita o en una lista con viñetas (escribir{" "}
        <code className="font-mono text-keep-action">&gt;</code> o{" "}
        <code className="font-mono text-keep-action">-</code> más un
        espacio al inicio de la línea también funciona). Los encabezados y
        la alineación son solo para las salas de chat, así que esos
        controles quedan ocultos en los foros.
      </p>
      <p className="text-[11px] text-keep-muted">
        Consejo: resalta una palabra en cualquier cuadro de texto para ver
        sinónimos. Arriba/Abajo para elegir, Enter para reemplazar, Esc
        para cerrar.
      </p>

      <div className="overflow-hidden rounded border border-keep-border">
        <table className="w-full text-[12px]">
          <thead className="bg-keep-panel/50 text-[10px] uppercase tracking-widest text-keep-muted">
            <tr>
              <th className="w-1/2 px-2 py-1 text-left">Tú escribes</th>
              <th className="w-1/2 px-2 py-1 text-left">Se muestra como</th>
            </tr>
          </thead>
          <tbody>
            {FORMATTING_ROWS.map((r) => (
              <tr key={r.syntax} className="border-t border-keep-border align-top">
                <td className="px-2 py-1.5 align-top">
                  <div className="font-mono text-keep-text">{r.example}</div>
                  {r.note ? (
                    <div className="mt-1 text-[10px] text-keep-muted">{r.note}</div>
                  ) : null}
                </td>
                <td className="px-2 py-1.5 align-top">
                  {/*
                    Se procesa con el mismo parseInline que usa MessageList,
                    así la vista previa siempre coincide con el chat real.
                  */}
                  <div className="text-keep-text">{parseInline(r.example)}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-5 border-t border-keep-rule/40 pt-3">
        <h3 className="mb-1 font-action text-sm uppercase tracking-widest text-keep-text">
          Comandos en línea
        </h3>
        <p className="text-keep-muted">
          Algunos comandos pueden insertarse a mitad de oración con un{" "}
          <code className="font-mono text-keep-action">!</code> inicial en lugar de ejecutarse como
          un comando de barra aparte. Escribe el nombre del comando y el servidor lo reemplaza ahí
          mismo con el texto generado, sin romper tu oración.
        </p>

        <div className="mt-2 overflow-hidden rounded border border-keep-border">
          <table className="w-full text-[12px]">
            <thead className="bg-keep-panel/50 text-[10px] uppercase tracking-widest text-keep-muted">
              <tr>
                <th className="w-1/2 px-2 py-1 text-left">Tú escribes</th>
                <th className="w-1/2 px-2 py-1 text-left">Aproximadamente lo que produce</th>
              </tr>
            </thead>
            <tbody>
              {/* Cada fila empareja el texto literal que alguien escribiría
                  con la salida real del parser de markdown, incluida la
                  marca de verificación que el servidor agrega en producción.
                  Así la documentación y el renderizado en vivo no pueden
                  divergir. (La salida de /roll es contenido generado por el
                  servidor y se muestra tal cual, en inglés.) */}
              <tr className="border-t border-keep-border align-top">
                <td className="px-2 py-1.5 font-mono text-keep-text">
                  tira un d20 !roll y espera
                </td>
                <td className="px-2 py-1.5 text-keep-text">
                  {parseInline(
                    `tira un d20 ${markVerified("roll", "( rolls 🎲 1d20: 17 )")} y espera`,
                  )}
                </td>
              </tr>
              <tr className="border-t border-keep-border align-top">
                <td className="px-2 py-1.5 font-mono text-keep-text">
                  tira !roll:3d6 de daño
                </td>
                <td className="px-2 py-1.5 text-keep-text">
                  {parseInline(
                    `tira ${markVerified("roll", "( rolls 🎲 3d6: [4, 2, 6] = 12 )")} de daño`,
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <p className="mt-2 text-keep-muted">
          La pequeña <span className="text-keep-system">✓</span> junto a un resultado insertado es la{" "}
          <b>marca de verificación</b>: pasa el cursor por encima y verás qué comando produjo el
          texto. Si alguna vez ves una salida con estilo de comando pero{" "}
          <em>sin</em> la ✓, alguien está escribiendo los mismos caracteres a mano para fingir un
          resultado; solo la salida que el servidor realmente ejecutó lleva la marca.
        </p>

        <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-keep-muted">
          <li>
            <b>Qué se puede llamar en línea</b> depende de la instalación. La paleta{" "}
            <code className="font-mono text-keep-action">!</code> del cuadro de mensaje lista cada
            comando que un admin habilitó en línea;{" "}
            <code className="font-mono text-keep-action">/roll</code> viene en línea por defecto
            (usa <code className="font-mono text-keep-action">!roll</code> o{" "}
            <code className="font-mono text-keep-action">!roll:3d6</code>).
          </li>
          <li>
            <b>Argumento opcional.</b> Lo que va después de los dos puntos, como{" "}
            <code className="font-mono text-keep-action">:3d6</code> en roll, se pasa al comando.
            La mayoría de los comandos personalizados no aceptan argumentos en línea y los ignoran
            en silencio.
          </li>
          <li>
            <b>¿Quieres escribir uno de forma literal?</b> Ponle una barra invertida delante:{" "}
            <code className="font-mono text-keep-action">{`\\!roll`}</code> se queda como el texto
            literal "<code className="font-mono text-keep-action">!roll</code>". Igual con{" "}
            <code className="font-mono text-keep-action">{`\\@nombre`}</code> cuando quieres decir
            un nombre de usuario sin mencionarlo. Ponerlos dentro de{" "}
            <code className="font-mono text-keep-action">`código`</code> o de un bloque de código
            también los mantiene literales.
          </li>
        </ul>
      </div>

      <div className="mt-5 border-t border-keep-rule/40 pt-3">
        <h3 className="mb-1 font-action text-sm uppercase tracking-widest text-keep-text">
          Publicaciones condicionales y de prueba
        </h3>
        <p className="text-keep-muted">
          Deja que los dados (o una moneda) decidan un desenlace, o agrega una pizca de azar a tus
          propios comandos personalizados. Escríbelos como su propio bloque o dentro del texto de un
          comando personalizado. La guía <b>Dados, pruebas y desenlaces de éxito/fallo</b> de la
          pestaña Guías los recorre todos con ejemplos.
        </p>

        <div className="mt-2 overflow-hidden rounded border border-keep-border">
          <table className="w-full text-[12px]">
            <thead className="bg-keep-panel/50 text-[10px] uppercase tracking-widest text-keep-muted">
              <tr>
                <th className="w-1/3 px-2 py-1 text-left">Tú escribes</th>
                <th className="px-2 py-1 text-left">Qué hace</th>
              </tr>
            </thead>
            <tbody>
              {CHECK_ROWS.map((r) => (
                <tr key={r.syntax} className="border-t border-keep-border align-top">
                  <td className="px-2 py-1.5 align-top">
                    <code className="block whitespace-pre-wrap break-words font-mono text-[11px] text-keep-action">
                      {r.syntax}
                    </code>
                  </td>
                  <td className="px-2 py-1.5 align-top">
                    <div className="text-keep-muted">{r.meaning}</div>
                    <div className="mt-1 text-[10px] text-keep-muted">
                      Ejemplo:{" "}
                      <code className="whitespace-pre-wrap break-words font-mono text-keep-text">
                        {r.example}
                      </code>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-5 border-t border-keep-rule/40 pt-3">
        <h3 className="mb-1 font-action text-sm uppercase tracking-widest text-keep-text">
          HTML de perfiles / mundos
        </h3>
        <p className="text-keep-muted">
          Los perfiles y las páginas de mundo son como pequeñas páginas web.
          Puedes usar casi cualquier HTML y CSS que quieras, incluido un
          bloque <code className="font-mono text-keep-action">&lt;style&gt;</code>{" "}
          al principio para dar tema a toda la biografía. Escribir texto
          normal también funciona. Presionar Enter dos veces deja una línea
          en blanco entre párrafos.
        </p>
        <p className="mt-2 text-keep-muted">
          Unas pocas cosas quedan bloqueadas para que nada raro pueda
          ejecutarse en las pantallas de otras personas:
        </p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px] text-keep-muted">
          {HTML_BLOCKED.map((b) => (
            <li key={b}><code className="font-mono text-keep-text">{b}</code></li>
          ))}
        </ul>

        <h4 className="mt-3 font-action text-xs uppercase tracking-widest text-keep-muted">
          Etiquetas comunes
        </h4>
        <div className="mt-1 overflow-hidden rounded border border-keep-border">
          <table className="w-full text-[12px]">
            <thead className="bg-keep-panel/50 text-[10px] uppercase tracking-widest text-keep-muted">
              <tr>
                <th className="w-1/4 px-2 py-1 text-left">Categoría</th>
                <th className="px-2 py-1 text-left">Etiquetas</th>
              </tr>
            </thead>
            <tbody>
              {HTML_COMMON_TAGS.map((g) => (
                <tr key={g.label} className="border-t border-keep-border align-top">
                  <td className="px-2 py-1.5 font-semibold text-keep-text">{g.label}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      {g.tags.map((t) => (
                        <code key={t} className="rounded bg-keep-panel/60 px-1 font-mono text-[11px] text-keep-action">
                          &lt;{t}&gt;
                        </code>
                      ))}
                    </div>
                    {g.note ? (
                      <div className="mt-1 text-[10px] text-keep-muted">{g.note}</div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h4 className="mt-3 font-action text-xs uppercase tracking-widest text-keep-muted">
          CSS personalizado con &lt;style&gt;
        </h4>
        <p className="text-keep-muted">
          Coloca un bloque <code className="font-mono text-keep-action">&lt;style&gt;</code>{" "}
          en cualquier parte de la biografía y escribe CSS normal. Tus
          reglas solo aplican dentro de tu propio perfil. Puedes usar
          cualquier selector, consultas @media, animaciones @keyframes,
          etcétera. Las hojas de estilo externas (@import) no se cargan.
        </p>

        <h4 className="mt-3 font-action text-xs uppercase tracking-widest text-keep-muted">
          Colores del tema
        </h4>
        <p className="text-keep-muted">
          Haz que tu biografía combine con el tema que elegiste usando estas
          variables de color. Siguen tu tema automáticamente, así la
          biografía se sigue viendo bien si cambias la paleta después.
        </p>
        <div className="mt-1 overflow-hidden rounded border border-keep-border">
          <table className="w-full text-[12px]">
            <thead className="bg-keep-panel/50 text-[10px] uppercase tracking-widest text-keep-muted">
              <tr>
                <th className="w-1/3 px-2 py-1 text-left">Variable</th>
                <th className="px-2 py-1 text-left">Qué es</th>
              </tr>
            </thead>
            <tbody>
              {THEME_VARS.map((v) => (
                <tr key={v.name} className="border-t border-keep-border align-top">
                  <td className="px-2 py-1 font-mono text-keep-action">{v.name}</td>
                  <td className="px-2 py-1 text-keep-text">{v.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-keep-muted">
          Úsalas directamente como colores:{" "}
          <code className="font-mono text-keep-action">color: var(--theme-accent)</code>.
          Para una versión atenuada, cada nombre de arriba también tiene una
          compañera <code className="font-mono text-keep-text">-rgb</code>{" "}
          que puedes poner dentro de <code className="font-mono text-keep-action">rgb(...)</code>:{" "}
          <code className="font-mono text-keep-action">background: rgb(var(--theme-accent-rgb) / 0.25)</code>.
        </p>

        <h4 className="mt-3 font-action text-xs uppercase tracking-widest text-keep-muted">
          Videos de YouTube
        </h4>
        <p className="text-keep-muted">
          Envuelve una URL de YouTube en{" "}
          <code className="font-mono text-keep-action">&lt;youtube&gt;...&lt;/youtube&gt;</code>{" "}
          y se convierte en un reproductor. Funciona con{" "}
          <code className="font-mono text-keep-text">youtube.com/watch</code>,{" "}
          <code className="font-mono text-keep-text">youtu.be</code>,{" "}
          <code className="font-mono text-keep-text">youtube.com/shorts</code>{" "}
          y URLs de embed. El reproductor llena la columna en celulares y se
          reduce a media anchura en escritorio.
        </p>
        <pre className="mt-1 overflow-x-auto rounded border border-keep-rule/60 bg-keep-panel/30 p-2 font-mono text-[10px] leading-relaxed">{`<youtube>https://youtu.be/dQw4w9WgXcQ</youtube>`}</pre>

        <h4 className="mt-3 font-action text-xs uppercase tracking-widest text-keep-muted">
          Ejemplo de biografía
        </h4>
        <pre className="overflow-x-auto rounded border border-keep-rule/60 bg-keep-panel/30 p-2 font-mono text-[10px] leading-relaxed">{`<style>
  .card {
    background: rgb(var(--theme-panel-rgb) / 0.6);
    border: 1px solid var(--theme-border);
    border-radius: 0.75rem;
    padding: 1rem;
    margin-bottom: 1rem;
  }
  .card h3 {
    color: var(--theme-accent);
    margin: 0 0 0.5rem 0;
  }
</style>

<div class="card">
  <h3>Nombre del personaje</h3>
  <p style="font-style:italic">"Una frase breve de apertura."</p>
</div>

<div class="card">
  <h3>De un vistazo</h3>
  <table>
    <tr><th>Edad</th><td>32</td></tr>
    <tr><th>Complexión</th><td>Alto, con cicatrices</td></tr>
  </table>
</div>

<details>
  <summary>Avisos de contenido</summary>
  <p>Duelo, violencia (nada en escena sin consentimiento).</p>
</details>

<youtube>https://youtu.be/dQw4w9WgXcQ</youtube>`}</pre>
        <p className="mt-1 text-[10px] text-keep-muted">
          La guía <b>Construir un perfil</b> de la pestaña Guías recorre el
          editor paso a paso con más ejemplos.
        </p>
      </div>

      <details className="rounded border border-keep-border bg-keep-panel/30 p-2">
        <summary className="cursor-pointer text-keep-muted">Casos límite y detalles</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-keep-muted">
          <li>
            <b>Los asteriscos funcionan dentro de una palabra.</b>{" "}
            <code>f**oo**bar</code> pone en negrita el <code>oo</code>. Los
            guiones bajos no - <code>snake_case_var</code> queda como texto
            plano.
          </li>
          <li>
            <b>Los espacios rompen el énfasis.</b> <code>* foo *</code> es
            texto plano; <code>*foo*</code> es cursiva. El carácter a cada
            lado del delimitador no puede ser un espacio.
          </li>
          <li>
            <b>Los delimitadores sin pareja se muestran tal cual.</b>{" "}
            <code>**sin cerrar</code> se muestra como <code>**sin cerrar</code>{" "}
            en lugar de desaparecer.
          </li>
          <li>
            <b>Los saltos de línea pasan como texto.</b> Los mensajes de
            varias líneas apilan sus líneas. En el chat, las líneas que
            empiezan con <code>&gt; </code> o <code>- </code> se agrupan en
            bloques de cita y listas con viñetas; las líneas de acción como
            /me las mantienen literales.
          </li>
          <li>
            <b>Las imágenes son opcionales.</b> Aunque una URL termine en
            <code>.png</code>, verás un enlace con un botón "Mostrar imagen" -
            haz clic para cargarla ahí mismo (máx. 480×360). El servidor de la
            imagen solo puede ver tu IP si haces clic;{" "}
            <code>referrerPolicy="no-referrer"</code> evita que la URL del
            chat se filtre por el Referer.
          </li>
          <li>
            <b>Los videos también son opcionales.</b> Pega un enlace de
            YouTube o Vimeo y verás un botón "Mostrar video". Haz clic para
            reproducirlo ahí mismo; el video queda fuera de la página hasta
            que lo hagas, así el enlace no avisa a ningún rastreador solo
            porque alguien pasó por encima.
          </li>
        </ul>
      </details>
    </div>
  );
}
