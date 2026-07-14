/**
 * Spanish (es) help-guide translations — the module loader.ts resolves for
 * "es" (and regional tags like "es-MX"). Stitched from the three i18n
 * fan-out chunks (welcome … worlds-application / worlds-attach … incognito /
 * tools … backups) into the single `guides` map the loader consumes; the
 * temporary chunk files are gone. Covers every canonical guide id in
 * ../en.tsx, which alone owns ids, ordering, and permission gates — this
 * module carries translated copy only (see ../types.ts), and any guide a
 * future edit adds to en.tsx before translating here falls back to English
 * PER GUIDE rather than blanking the modal. Voice/terms follow
 * packages/shared/locales/es/GLOSSARY.md.
 */
import { buildUiRouteHelp } from "@thekeep/shared";
import { useChat } from "../../../state/store.js";
import { UiRouteIcon } from "../../../lib/uiRouteIcons.js";
import { Bullets, Heading, K, P, Steps, Tip } from "../blocks.js";
import type { HelpGuideTranslations } from "../types.js";

/**
 * Spanish body of the "shortcut-chips" guide. Mirrors NavigationTagsGuide
 * in ../en.tsx: the tag reference is generated from the live catalog and
 * filtered to the tags THIS viewer may author via the shared
 * `buildUiRouteHelp`; only the wrapper prose is translated.
 */
function NavigationTagsGuideEs() {
  const role = useChat((s) => s.me?.role ?? null);
  const groups = buildUiRouteHelp(role);
  return (
    <>
      <P>
        Las etiquetas de navegación son pequeños atajos clicables que puedes soltar en el chat o
        en un anuncio. Escribe una palabra clave entre llaves y se convierte en un botón que abre
        la página, el menú o el lugar correspondiente. Quien lo lee solo hace clic. Funcionan en
        los mensajes de chat, las publicaciones de los foros, los mensajes directos y los anuncios
        (la marquesina del banner y las líneas programadas).
      </P>
      <P>
        Por ejemplo, escribir <K>{"¡pasa por la {shop}!"}</K> publica "¡pasa por la" seguido de
        una etiqueta <b>Shop</b> clicable que abre la tienda.
      </P>
      <Tip label="Consejo">
        Cualquier cosa entre llaves que no sea una etiqueta real se queda como texto normal, así
        que escribir <K>{"{nervioso}"}</K> en el rol es perfectamente seguro. Solo se convierte en
        etiqueta cuando la palabra clave coincide con una de las de abajo.
      </Tip>

      <Heading>Enlaza a un mundo o una sala específicos</Heading>
      <P>Algunas etiquetas aceptan un "identificador" corto para que apuntes a un lugar exacto:</P>
      <Bullets>
        <li>
          <K>{"{world:the-handle}"}</K> abre ese mundo. El identificador es el slug del mundo (el
          nombre corto de su dirección web, como <K>elyria</K>).
        </li>
        <li>
          <K>{"{room:the-handle}"}</K> salta a esa sala. Para encontrar el identificador de una
          sala, entra a la sala y escribe <K>/slug</K>; te muestra el identificador y el{" "}
          <K>{"{room:...}"}</K> exacto para pegar. Los propietarios y mods pueden establecer uno
          personalizado con <K>/slug my-handle</K>.
        </li>
        <li>
          <K>{"{scriptorium:the-handle}"}</K> abre esa historia en el lector. El identificador es
          el slug de la historia (el nombre corto de su dirección web).{" "}
          <K>{"{scriptorium:latest:story}"}</K> siempre apunta a la historia publicada más
          reciente.
        </li>
        <li>
          <K>{"{forum:the-handle}"}</K> abre ese foro. El identificador es el slug del foro (el
          nombre corto de su dirección <K>/f/</K>, como <K>feedback</K>). El <K>{"{forums}"}</K> a
          secas abre todo el catálogo de Foros.
        </li>
        <li>
          <K>{"{post:the-id}"}</K> salta directo a una publicación del foro y abre su hilo. Copia el
          id con el botón <b>Copiar enlace</b> de la publicación. La etiqueta muestra el título del
          tema.
        </li>
      </Bullets>
      <P>
        La etiqueta muestra el nombre real del mundo, la sala, la historia o el foro (y una etiqueta
        de publicación muestra el título de su tema), y respeta la privacidad: si alguien no puede
        ver ese lugar, la etiqueta se queda como texto normal para esa persona, sin hacer ruido.
      </P>

      <Heading>Todas las etiquetas que puedes usar</Heading>
      <P>
        Estas son las etiquetas disponibles para ti. Escribe cualquiera entre llaves (por ejemplo{" "}
        <K>{"{rules}"}</K>) y se convierte en una etiqueta clicable.
      </P>
      {groups.map((g) => (
        <div key={g.label} className="space-y-1">
          <div className="font-semibold text-keep-text">{g.label}</div>
          <ul className="list-disc space-y-1 pl-5">
            {g.entries.map((e) => (
              <li key={e.token}>
                <K>{`{${e.token}}`}</K>{" "}
                <span className="text-keep-muted">
                  <UiRouteIcon name={e.icon} className="mr-1 inline-block h-3.5 w-3.5 align-text-bottom text-keep-action" />
                  {e.label}. {e.description}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

export const guides: HelpGuideTranslations = {
  welcome: {
    title: "Te damos la bienvenida a The Spire",
    body: (
      <>
        <P>
          The Spire es un chat de rol libre. Escribes personajes, pasas el rato en salas y cuentas
          historias con los demás. Nadie está obligado a usar tiradas ni estadísticas - el sistema
          no estorba y te deja escribir.
        </P>
        <Heading>Dos capas de identidad</Heading>
        <Bullets>
          <li>
            <b>Tu cuenta principal</b> - la persona OOC detrás del teclado. Tiene su propio nombre,
            perfil, tema y color.
          </li>
          <li>
            <b>Tus personajes</b> - tantas identidades como quieras encarnar. Cada personaje tiene
            su propio nombre, perfil, galería y estadísticas. Mientras esté "activo", tus mensajes
            aparecen bajo el nombre de ese personaje y con su estilo.
          </li>
        </Bullets>
        <P>
          Puedes entrar y salir de tus personajes en cualquier momento. Cuando no hay ningún
          personaje activo, publicas OOC con tu nombre principal.
        </P>
      </>
    ),
  },

  "chat-basics": {
    title: "Lo básico del chat: moverte con clics",
    body: (
      <>
        <P>
          Casi todo lo que ves en el chat responde al clic. Cuando sabes qué hace cada clic, casi
          nunca necesitas escribir comandos.
        </P>

        <Heading>En la ventana del chat</Heading>
        <Bullets>
          <li>
            <b>Haz clic en el nombre de quien envía</b> un mensaje para iniciarle un susurro. Tu
            cuadro de mensaje se llena con <K>/whisper {`<name>`} </K> - termina de escribir y
            presiona Enter. Para abrir su perfil desde el chat, haz clic en su <K>@username</K> en
            cualquier mensaje, o en su nombre en la barra derecha (el ícono de género solo aparece
            en la barra; las líneas del chat se mantienen compactas).
          </li>
          <li>
            <b>Haz clic en la hora de un mensaje</b> para responderlo. El cuadro se llena con{" "}
            <K>/reply {`<id>`} </K> y tu siguiente mensaje queda enlazado bajo ese. Solo funciona
            en líneas de chat (mensajes normales, acciones /me, OOC); las líneas del sistema y los
            anuncios no aceptan respuestas.
          </li>
          <li>
            <b>Haz clic en una mención @username</b> dentro de un mensaje para abrir el perfil de
            esa persona. Si tiene un personaje activo, se abre el perfil del personaje; si no, el
            de la cuenta principal.
          </li>
          <li>
            <b>Haz clic en una etiqueta @world:slug</b> para abrir el visor de ese mundo. Tu
            membresía no cambia - es solo un enlace.
          </li>
        </Bullets>

        <Heading>En la barra derecha (salas + lista de usuarios)</Heading>
        <Bullets>
          <li><b>Haz clic en el nombre de una sala</b> para cambiarte a ella. Las salas privadas piden contraseña.</li>
          <li>
            <b>Haz clic en el ícono de género de un ocupante</b> (el pequeño símbolo junto a su
            nombre en la barra) para abrir su perfil. Es el único lugar donde el ícono acepta
            clics - las líneas del chat lo ocultan para mantener compacta la conversación.
          </li>
          <li><b>Haz clic en el nombre de un ocupante</b> en la barra para susurrarle - igual que con un nombre en el chat.</li>
          <li>
            <b>Haz clic en el encabezado de un mundo</b> en la barra (cuando una sala agrupa a sus
            ocupantes por su mundo principal) para abrir el visor de ese mundo.
          </li>
          <li>
            <b>El botón "▲ Herramientas" al final de la barra</b> abre el panel de Herramientas,
            con botones para cada acción común - tiene su propia guía más abajo.
          </li>
        </Bullets>

        <Heading>El cuadro de mensaje (donde escribes)</Heading>
        <Bullets>
          <li><b>Enter</b> envía tu mensaje. <b>Shift+Enter</b> inserta un salto de línea para publicaciones con párrafos.</li>
          <li>
            Escribir <K>/</K> al inicio de un mensaje abre una ventana de autocompletado con los
            comandos que coinciden. <b>Up/Down</b> navega, <b>Enter</b> o <b>Tab</b> acepta,{" "}
            <b>Esc</b> la cierra.
          </li>
          <li>
            Escribir <K>@</K> en cualquier parte abre un autocompletado con los usuarios presentes
            en la sala. Mismos controles.
          </li>
          <li>
            Escribir <K>!</K> a mitad de mensaje abre un autocompletado de <b>comandos en línea</b>,
            que insertan su resultado dentro de la oración en lugar de ejecutarse como comando
            aparte. <K>!roll</K> inserta una tirada de dados, <K>!roll:3d6</K> usa los dados que
            indiques, y los admins pueden marcar sus comandos personalizados como en línea. Las
            expansiones reales muestran una ✓ pequeña que, al pasar el cursor, nombra el comando
            usado, así una imitación tecleada a mano no pasa por el resultado real. Escribe{" "}
            <K>{`\\!roll`}</K> (con una barra invertida delante) para dejar el texto literal.
          </li>
          <li>
            Todo lo que no empiece con <K>/</K> es un mensaje normal de diálogo. Envuelve una
            oración en <K>/me {`<action>`}</K> para publicar una acción en tercera persona
            ("Sigrid desenvaina su espada.").
          </li>
          <li>
            Atajo de acción rápida: empieza una línea con <K>:</K> y el resto
            se vuelve una acción. <K>:entra con toda calma</K> es lo mismo que
            <K>/me entra con toda calma</K>. Si de verdad quieres empezar un
            mensaje con dos puntos, escribe dos: <K>::así</K>.
          </li>
        </Bullets>

        <Heading>Editar y eliminar tus propios mensajes</Heading>
        <P>
          Durante un minuto después de enviarlos, tus propios mensajes de chat muestran pequeños
          controles de <b>editar</b> y <b>eliminar</b> en la línea. Pasada esa ventana de gracia,
          los controles desaparecen y el mensaje queda permanente (salvo las limpiezas automáticas
          o el vencimiento configurado por sala).
        </P>
        <P>
          Los mensajes eliminados se reducen a "[mensaje eliminado]" - el contenido original se
          borra en el servidor, así que incluso tu vista anterior de la línea se limpia la próxima
          vez que la página se recarga.
        </P>

        <Heading>Leer respuestas</Heading>
        <P>
          Cuando alguien responde a un mensaje con <K>/reply</K> (o con clic en la hora), la
          respuesta aparece con una pequeña línea citada encima: <i>↪ Sigrid: ...el fragmento
          original...</i> Ese fragmento es el mensaje original recortado, para que veas a qué se
          responde sin subir por el historial. Haz clic en el nombre citado para abrir el perfil
          de su autor.
        </P>

        <Heading>Marcas y etiquetas que verás junto a los nombres</Heading>
        <Bullets>
          <li>
            <b>♛</b> (la reina de ajedrez) = el <b>propietario de la sala</b>. Quien usó{" "}
            <K>/private</K> o <K>/go</K> para crear la sala. Es por sala - las salas del sistema
            (The_Spire, Tavern, etc.) no tienen propietario, así que ahí nadie la lleva.
          </li>
          <li>
            <b>★</b> (estrella) = un <b>mod</b>. Puede ser mod de la sala (ascendido por el
            propietario con <K>/promote</K>) <i>o</i> mod del sitio (mod en todas las salas). La
            estrella es la misma; un mod del sitio es, en la práctica, "un mod en todas partes".
          </li>
          <li>
            <b>Nombre en cursiva</b> = un <b>admin del sitio</b> (a nivel de cuenta). Se ve en
            todas partes - en la lista de usuarios, en las líneas del chat, en los perfiles. Los
            admins del sitio tienen poder de admin en cada sala, sin importar su rol por sala.
          </li>
          <li>
            <b>[ausente]</b> = la persona activó <K>/away</K>. Pasa el cursor sobre su nombre para ver el motivo.
          </li>
          <li><b>Etiqueta de ánimo</b> ("melancólico", "engreído") = la persona usó <K>/mood</K>.</li>
          <li><b>[ooc]</b> en la lista de usuarios = sin personaje activo; es su cuenta principal.</li>
        </Bullets>
        <Tip label="Consejo">
          Si creaste una sala pero ahora estás en una sala del sistema (The_Spire, etc.), no verás
          tu propia ♛ - esa marca es por sala. Cámbiate a una sala tuya y tu nombre recupera el
          distintivo.
        </Tip>

        <Heading>Notificaciones</Heading>
        <P>
          Cuando la pestaña está en segundo plano, que te <K>@mencionen</K> o te susurren dispara
          una notificación de escritorio (si diste permiso). La preferencia de notificaciones
          (desactivadas / solo menciones / todos los mensajes) vive en el editor de tu perfil -
          abre <K>/profile</K> y elige en el menú de Notificaciones. Por defecto: solo menciones.
        </P>
      </>
    ),
  },

  "getting-started": {
    title: "Primeros pasos: la interfaz",
    body: (
      <>
        <P>
          Te damos la bienvenida a The Spire. Este es un recorrido rápido por la pantalla para que
          sepas dónde vive cada cosa. Puedes volver aquí cuando quieras desde Ayuda, así que no hay
          nada que memorizar.
        </P>
        <Tip label="Consejo">
          ¿Recién llegas? La primera vez que inicias sesión, este mismo paseo aparece como un
          recorrido guiado que ilumina cada parte de la pantalla. Puedes saltarlo y leer esta
          página, o repetir el recorrido más tarde.
        </Tip>

        <Heading>Tu nombre y tus personajes</Heading>
        <P>
          Abajo, al final de la barra derecha, verás un botón con tu nombre. Ese botón es tu
          selector de identidad. Haz clic para encarnar a uno de tus personajes, crear un personaje
          nuevo o volver a ser tú (fuera de personaje).
        </P>
        <P>
          Mientras un personaje está activo, todo lo que publicas aparece con su nombre y su
          estilo. Cuando no hay personaje activo, publicas como tú.
        </P>
        <Tip label="Consejo">
          Tu nombre al final de la barra sirve para cambiar de identidad al publicar. Para abrir tu
          página de perfil, usa el Menú, como te contamos abajo.
        </Tip>

        <Heading>Abre y edita tu perfil</Heading>
        <P>
          Tú y cada personaje que crees tienen su página de perfil. Para abrir la tuya y editarla,
          abre el Menú (el botón al fondo de la barra) y, en Cuenta, elige Editar perfil. También
          puedes escribir <K>/profile</K> en el chat.
        </P>
        <Steps>
          <li>Abre el Menú al final de la barra.</li>
          <li>Abre la sección Cuenta y haz clic en Editar perfil.</li>
          <li>Agrega una foto, una biografía y los detalles que quieras, y presiona Guardar.</li>
        </Steps>
        <Tip label="Consejo">
          Para asomarte al perfil de alguien más, haz clic en su nombre o su foto en el chat, o en
          su nombre en la barra. Hacer clic en tu propio nombre en el chat muestra tu perfil tal
          como lo ven las visitas.
        </Tip>

        <Heading>El Menú lo guarda todo</Heading>
        <P>
          El botón Menú al final de la barra es tu centro de operaciones. Ábrelo y encontrarás tu
          perfil, tus mundos, los foros, tus mensajes y amigos, y más, todo en un solo lugar.
        </P>
        <Bullets>
          <li>Cuenta, editar tu perfil, billetera y Recompensas, marcadores.</li>
          <li>Personas, tus mensajes, amigos y solicitudes de amistad.</li>
          <li>Creación de mundos, tus mundos y el catálogo de mundos.</li>
          <li>Foros, el catálogo de foros y tus propios tableros.</li>
          <li>Ayuda / Comandos, guías como esta más todos los comandos.</li>
        </Bullets>
        <Tip label="Consejo">
          Cuando no sepas dónde está algo, abre el Menú primero. Casi cada rincón del sitio tiene
          una puerta aquí.
        </Tip>

        <Heading>Escribir en el chat</Heading>
        <P>
          El cuadro en la parte de abajo de la pantalla es donde escribes. Escribe un mensaje y
          presiona Enter para enviarlo. Mantén Shift y presiona Enter para empezar otra línea en
          publicaciones largas.
        </P>
        <Bullets>
          <li>
            Empieza una línea con <K>/</K> para usar un comando. Mientras escribes aparece una
            lista, así que no tienes que memorizar nada.
          </li>
          <li>Escribe <K>@</K> para mencionar a alguien. Elígelo de la lista y le llegará un aviso.</li>
          <li>
            Empieza una línea con <K>:</K> para escribir una acción. Si escribes{" "}
            <K>:desenvaina su espada</K>, se publica como una acción en tercera persona.
          </li>
        </Bullets>
        <Tip label="Consejo">
          Rara vez necesitas comandos. Casi todo está a un clic en la barra y el Menú.
        </Tip>

        <Heading>Cambiar de sala</Heading>
        <P>
          La barra de la derecha lista cada sala a la que puedes entrar, con cuánta gente hay en
          cada una. Haz clic en el nombre de una sala para saltar a ella. Las salas privadas piden
          una invitación o una contraseña.
        </P>
        <P>En el celular, toca el botón Menú junto al cuadro de mensaje para deslizar la lista de salas.</P>
        <Tip label="Consejo">
          ¿Quieres tu propio espacio? Usa el botón Nueva arriba de la lista de salas, o escribe{" "}
          <K>/go</K> seguido de un nombre de sala para crearla al instante.
        </Tip>

        <Heading>Foros y comunidades</Heading>
        <P>
          El chat en vivo se pierde al avanzar. Los foros son para lo que quieres conservar, fichas
          de personaje, lore, hilos pausados. Abre el Catálogo de foros con el botón fijado justo
          arriba de la lista de salas, desde la sección Foros del Menú, o escribiendo <K>/forums</K>.
        </P>
        <P>
          Si las comunidades están activadas, una franja delgada de íconos redondos recorre el
          borde exterior. Cada ícono es una comunidad a la que te uniste. El botón al final de esa
          franja te deja descubrir más comunidades, o solicitar la tuya.
        </P>
        <Tip label="Consejo">
          Puedes repetir este recorrido cuando quieras. Abre Ayuda desde el Menú y busca la opción
          para mostrar de nuevo el recorrido de la interfaz.
        </Tip>
      </>
    ),
  },

  "dice-checks": {
    title: "Dados, pruebas y desenlaces de éxito o fallo",
    body: (
      <>
        <P>
          Cuando una escena necesita un poco de azar, deja que los dados decidan. Cada resultado se
          tira en el servidor y no se puede repetir ni falsificar, así que toda la sala puede
          confiar en el desenlace. Funciona igual en una sala en vivo y en una respuesta de foro,
          así que una escena de rol por publicaciones puede apoyarse en los dados igual que un chat
          rápido.
        </P>

        <Heading>Tirar los dados</Heading>
        <P>Tira en su propia línea con <K>/roll</K> y la sala ve un resultado limpio.</P>
        <Bullets>
          <li><K>/roll 1d20</K> tira un dado de veinte caras.</li>
          <li>
            <K>/roll 3d6</K> tira tres dados de seis caras y muestra cada dado más el total, como{" "}
            <K>[4, 2, 6] = 12</K>.
          </li>
          <li><K>/roll d20</K> es la forma corta de <K>1d20</K> (la cantidad empieza en 1).</li>
          <li><K>/roll 1d20+3</K> suma un bono fijo. <K>/roll 2d6-1</K> resta uno.</li>
          <li>
            <K>!roll</K> a mitad de oración inserta una tirada en la línea que escribes.{" "}
            <K>!roll</K> a secas es un d20; <K>!roll:3d6</K> o <K>!roll:1d20+3</K> usa los dados
            que elijas.
          </li>
        </Bullets>
        <Tip label="Consejo">
          Puedes tirar hasta 100 dados de hasta 1000 caras, con un bono de -999 a +999. No se
          permiten espacios dentro de los dados: escribe <K>1d20+3</K>, no <K>1d20 + 3</K>.
        </Tip>

        <Heading>Una prueba rápida</Heading>
        <P>
          <K>/check</K> es la llamada más simple: un 50/50 limpio de Éxito o Fallo, publicado a la
          vista de la sala. Suelta <K>!check</K> dentro de una oración para lo mismo en línea:
          "intenta la cerradura !check" se lee como "intenta la cerradura ( check: ✓ Éxito )".
        </P>

        <Heading>Desenlaces de éxito o fallo</Heading>
        <P>
          Escribe ambos desenlaces por adelantado y deja que el resultado revele cuál ocurrió. La
          sala ve una tarjeta con el veredicto arriba, el desenlace ganador ya abierto y el otro
          guardado por si alguien quiere espiarlo. Es un simple 50/50, como una moneda al aire.
        </P>
        <P>Envuelve tus dos desenlaces en un bloque de prueba así:</P>
        <pre className="overflow-x-auto rounded border border-keep-rule/60 bg-keep-panel/30 p-2 font-mono text-[10px] leading-relaxed">{`/me trabaja la ganzúa en la vieja cerradura.
<check>
  <pass>La cerradura cede con un clic suave.</pass>
  <fail>La ganzúa se parte dentro del mecanismo.</fail>
</check>`}</pre>
        <Tip label="Consejo">
          Necesitas al menos una línea <K>{"<pass>"}</K> o <K>{"<fail>"}</K> dentro del bloque. Si
          faltan las dos, la sala ve el texto tal cual, algo útil para enseñar cómo se escribe una
          prueba sin dispararla.
        </Tip>

        <Heading>Deja que los dados decidan el desenlace</Heading>
        <P>
          Cambia <K>{"<check>"}</K> por una tirada con un número objetivo. La tirada debe igualar o
          superar el objetivo para tener éxito. Se abre con <K>{"<roll:dice:target>"}</K> y se
          cierra con <K>{"</roll>"}</K> (o <K>{"</check>"}</K>, ambos funcionan).
        </P>
        <pre className="overflow-x-auto rounded border border-keep-rule/60 bg-keep-panel/30 p-2 font-mono text-[10px] leading-relaxed">{`/me lanza un tajo a las cuerdas que sostienen el puente.
<roll:1d20:12>
  <pass>Las cuerdas se cortan limpias y restallan hacia el centro.</pass>
  <fail>La cuerda apenas queda marcada. Esto tomará un tiempo que no tienen.</fail>
</roll>`}</pre>
        <Bullets>
          <li><K>{"<roll:1d20:12>"}</K> tira un d20; con 12 o más hay éxito.</li>
          <li><K>{"<roll:1d20+3:12>"}</K> suma un bono fijo antes de comparar con el objetivo.</li>
          <li>
            <K>{"<roll:1d20x1.5:12>"}</K> multiplica la tirada (útil para ventaja o una mejora).
            Usa una x minúscula, como <K>1d20x1.5</K>.
          </li>
        </Bullets>
        <Tip label="Consejo">
          La tarjeta muestra la cuenta que usó, como "1d20: 16  +3 = 19  vs 12", para que todos
          vean la tirada, el bono y el objetivo que la decidió. Un bloque acepta un bono a la vez:
          o un +X/-X fijo o un multiplicador con x, no ambos.
        </Tip>

        <Heading>Una dificultad de la casa para la sala</Heading>
        <P>
          Propietarios y mods de una sala pueden fijar una sola dificultad para toda la sala con{" "}
          <K>/roll dc 15</K>. Una vez fijada, cada <K>/roll</K> simple en esa sala se marca como
          Éxito o Fallo frente a ella, así una partida mantiene una vara estable sin escribir el
          objetivo en cada tirada. <K>/roll dc</K> muestra la dificultad actual y{" "}
          <K>/roll dc clear</K> la quita. La tirada debe igualar o superar el número para tener
          éxito.
        </P>

        <Heading>Iniciativa</Heading>
        <P>
          <K>/initiative</K> (o <K>/init</K>) tira un d20 para el orden de turnos. Agrega un bono
          con <K>/init +3</K>. Si la sala tiene dificultad fijada, la tirada de iniciativa también
          se marca como Éxito o Fallo frente a ella.
        </P>

        <Heading>Azar dentro de tus propios comandos</Heading>
        <P>
          Si creas comandos personalizados para tu comunidad (desde el menú de comandos), puedes
          ponerle una pizca de azar al texto del comando. Estos ayudantes solo funcionan dentro de
          la plantilla de un comando personalizado, no en una línea normal del chat, y se ejecutan
          cada vez que alguien usa el comando:
        </P>
        <Bullets>
          <li>
            <K>{"{roll:1d20}"}</K> inserta el total de una tirada al azar. Muestra solo el número y
            no acepta bonos de más o menos, así que úsalo con dados simples como <K>{"{roll:2d6}"}</K>.
          </li>
          <li>
            <K>{"{choose:cálidamente|secamente|suavemente}"}</K> elige una opción al azar. La forma
            corta <K>{"{a|b|c}"}</K> hace lo mismo.
          </li>
          <li>
            <K>{"{if:condition|then|else}"}</K> muestra el texto del "then" cuando la condición
            tiene algo, o el del "else" cuando está vacía (o es 0, o false). La parte "else" es
            opcional.
          </li>
          <li>
            <K>{"{=10+5}"}</K> hace cuentas rápidas con + - * / y paréntesis. Hasta puedes anidar,
            como <K>{"{=10+{roll:1d20}}"}</K> para sumar un dado a un número base.
          </li>
        </Bullets>
        <Tip label="Consejo">
          Lo que el comando no entiende queda en pantalla tal como lo escribiste, así que un{" "}
          <K>{"{algo}"}</K> perdido es fácil de ver y corregir.
        </Tip>

        <Heading>Meter un comando en una oración</Heading>
        <P>
          Cualquier comando personalizado configurado para funcionar en línea puede usarse a mitad
          de oración escribiendo <K>!</K> antes de su nombre, como <K>!wave</K> o <K>!greet</K>. El
          texto del comando cae justo donde lo pusiste, marcado con una ✓ para que la sala sepa que
          es auténtico.
        </P>
        <P>
          ¿Quieres mostrar cómo se ve un comando sin dispararlo? Ponle una barra invertida delante,
          como <K>{"\\!wave"}</K>, y queda como texto plano. Los comandos escritos dentro de
          formato de código también se dejan en paz.
        </P>
        <Tip label="Consejo">
          Todo esto funciona igual en las respuestas de foro que en el chat, así que una escena
          pausada de rol por publicaciones puede apoyarse en los dados y en tus comandos
          personalizados igual que una sala en vivo.
        </Tip>
      </>
    ),
  },

  characters: {
    title: "Personajes: crear, cambiar, retirar",
    body: (
      <>
        <P>
          Un personaje es una identidad. Actívalo y te conviertes en él dentro del chat - misma
          sala, misma conversación, distinto nombre.
        </P>
        <Heading>Crea un personaje nuevo</Heading>
        <Steps>
          <li>Abre <K>/profile</K> (o usa el panel de <b>Herramientas</b> abajo a la derecha de la barra).</li>
          <li>En el editor, haz clic en <b>Nuevo personaje</b> y completa nombre + biografía.</li>
          <li>Guarda. El personaje ahora vive en tu cuenta.</li>
        </Steps>
        <Heading>Encarna a un personaje</Heading>
        <Steps>
          <li>Abre el perfil del personaje (haz clic en su nombre en cualquier parte del chat).</li>
          <li>Usa el botón <b>Cambiar a {`<name>`}</b> - tu perfil principal muestra la misma opción para regresar a OOC.</li>
        </Steps>
        <P>
          O con comandos: <K>/char list</K> para ver tus personajes, <K>/char switch {`<name>`}</K> para encarnar uno,
          <K>/char clear</K> para volver a OOC.
        </P>
        <Tip label="Consejo">
          Tu personaje activo controla más que el nombre visible - su género, tema y color de chat
          reemplazan tu configuración principal mientras está activo.
        </Tip>
      </>
    ),
  },

  "identity-tokens": {
    title: "Señalar a la persona correcta (@id y @cid)",
    body: (
      <>
        <P>
          La mayoría de los comandos dirigidos a alguien aceptan un nombre:{" "}
          <K>/whisper Sigrid hola</K>. Funciona bien hasta que el nombre tiene un espacio, o dos
          personas comparten nombre. Para esos casos existen <b>tokens de identidad</b> exactos que
          nunca se confunden.
        </P>
        <Heading>Los dos tokens</Heading>
        <Bullets>
          <li>
            <K>@id:{`<userId>`}</K> apunta a una <b>cuenta</b> completa (la persona, OOC).
          </li>
          <li>
            <K>@cid:{`<characterId>`}</K> apunta a un <b>personaje</b> específico.
          </li>
        </Bullets>
        <Heading>Dónde conseguirlos</Heading>
        <P>
          Abre el perfil de alguien y busca la pequeña etiqueta de <b>copiar token</b>. Tócala y el
          token correcto queda en tu portapapeles, listo para pegarse en un comando. No hace falta
          teclear el id largo a mano.
        </P>
        <Heading>Cómo se usa</Heading>
        <P>
          Suelta el token donde un comando pida un nombre. Sirve para susurros, amigos, bloqueos,
          ignorados, enviar Monedas, duelos, acciones de mod y más.
        </P>
        <Bullets>
          <li><K>/whisper @cid:abc123 ¿tienes libre esta noche para escribir?</K></li>
          <li><K>/friend @id:def456</K></li>
          <li><K>/currency send @cid:abc123 50</K></li>
        </Bullets>
        <Tip label="Consejo">
          Si al escribir un nombre te aparece un selector de "ambigüedad" (dos personas coinciden),
          el selector lista cada coincidencia con su token. Copia el correcto en tu comando y
          llegarás exactamente a quien querías.
        </Tip>
      </>
    ),
  },

  "profile-create": {
    title: "Crear tu perfil",
    body: (
      <>
        <P>
          Tú y cada personaje que crees tienen una página de perfil. Los demás la ven al hacer clic
          en tu nombre. La biografía es el área grande de texto donde te describes a ti o a tu
          personaje.
        </P>

        <Heading>Abre tu editor</Heading>
        <Steps>
          <li>Escribe <K>/profile</K> en el chat, o abre el panel de Herramientas y elige <b>Editar perfil</b>.</li>
          <li>Empiezas en tu cuenta principal (OOC). Usa el menú de arriba para cambiar a uno de tus personajes, o para crear uno nuevo.</li>
        </Steps>

        <Heading>Qué hace cada pestaña</Heading>
        <Bullets>
          <li><b>Descripción</b> es la biografía. Lo principal que leen las visitas.</li>
          <li><b>Perfil</b> es tu nombre, foto, género y datos del personaje como edad y raza.</li>
          <li><b>Apariencia</b> es colores y tipografías.</li>
          <li><b>Privacidad</b> es quién puede ver el perfil, interruptores para sonidos y notificaciones, y si permites MD.</li>
          <li><b>Enlaces</b> son etiquetas pequeñas arriba del perfil (Discord, Twitter y demás).</li>
          <li><b>Galería</b> son imágenes extra para un personaje.</li>
          <li><b>Diario</b> son entradas de diario escritas en personaje, para un personaje.</li>
        </Bullets>

        <Heading>Escribir la biografía</Heading>
        <P>
          La biografía es texto plano por defecto. Presiona <b>Guardar</b> al terminar. Si quieres
          más control, también puedes usar un pequeño conjunto de etiquetas HTML para agregar
          encabezados, listas, enlaces, tablas y demás. La pestaña <b>Formato</b> de esta Ayuda
          tiene la lista completa de lo permitido, con un ejemplo que puedes copiar.
        </P>
        <P>
          En una pantalla ancha quizá veas también un interruptor <b>Diseñador</b> y <b>Código</b>{" "}
          arriba de la biografía. <b>Diseñador</b> te deja armar la página arrastrando piezas
          (encabezados, tarjetas, columnas, una imagen, un video) y dándoles estilo con clics, sin
          escribir HTML.
          <b> Código</b> es la misma biografía como HTML puro, para control total o para pegar un
          tema. Lo que cambies en uno aparece en el otro, así que puedes bosquejar en Diseñador y
          afinar los detalles en Código.
        </P>

        <Heading>Un ejemplo simple</Heading>
        <pre className="overflow-x-auto rounded border border-keep-rule/60 bg-keep-panel/30 p-2 font-mono text-[10px] leading-relaxed">{`<h3>Sigrid la Callada</h3>
<p>Una cantora de espadas retirada que atiende una posada
tranquila al pie de las montañas. Habla poco. Lo observa todo.</p>

<h4>De un vistazo</h4>
<ul>
  <li>Edad: cuarenta y muchos</li>
  <li>Complexión: delgada, antebrazos con cicatrices</li>
  <li>Voz: grave, medida, rara vez se alza</li>
</ul>

<details>
  <summary>Avisos de contenido (clic para abrir)</summary>
  <p>Toca el duelo y alguna herida de combate ocasional.
  Nada en escena sin acuerdo previo.</p>
</details>`}</pre>

        <Tip label="Consejo">
          El editor de biografía no guarda solo. Presiona <b>Guardar</b> antes de cambiar de
          personaje, o perderás tus cambios.
        </Tip>

        <Heading>Zoom y recorte del avatar</Heading>
        <P>
          Cuando eliges una foto de perfil en la pestaña <b>Perfil</b>, aparece una pequeña
          herramienta de encuadre justo debajo de la URL de la imagen. Arrastra la foto dentro del
          círculo y ajusta el control de zoom para decidir el recorte. Tu encuadre te sigue a donde
          aparezca tu avatar, incluidas las líneas del chat, las listas de miembros y la galería de
          miembros de un mundo.
        </P>

        <Heading>Barras de Temperamento, atributos y visibilidad de secciones (personajes)</Heading>
        <P>
          Los personajes tienen algunos paneles extra en el editor:
        </P>
        <Bullets>
          <li>
            <b>Las barras de Temperamento</b> son ocho diales de personalidad, cosas como de
            Pacifista a Combativo o de Frío a Cálido. Ajústalas para que las visitas lean de un
            vistazo quién es tu personaje. Déjalas al centro y el panel se oculta en el perfil.
          </li>
          <li>
            <b>Atributos</b> son las estadísticas numéricas que quieras, como STR 14 o HP 45, con
            tus propias etiquetas y rangos. Úsalos o sáltalos. Nada te impone un sistema.
          </li>
          <li>
            <b>Visibilidad de secciones</b> te deja ocultar campos sueltos (edad, raza, estatura y
            demás) o secciones enteras (Temperamento, Atributos, Galería) de la vista pública, sin
            dejar de guardarlos en tu editor.
          </li>
        </Bullets>

        <Heading>Extras de adornos (compras de la tienda)</Heading>
        <P>
          Tres adornos opcionales viven en el editor de <b>Adornos</b> del perfil. Cada uno se
          compra una sola vez con Monedas en la tienda y queda disponible en cada perfil de esa
          identidad.
        </P>
        <Bullets>
          <li>
            <b>Marquesina de citas</b> es una franja rotativa de hasta <b>diez</b> citas entre el
            encabezado del perfil y la biografía. Agrégalas y reordénalas en el editor de adornos.
          </li>
          <li>
            <b>Contador de visitas</b> muestra cuánta gente ha visto el perfil, separando
            visitantes con sesión iniciada y anónimos. Actívalo en el editor de adornos después de
            comprarlo.
          </li>
          <li>
            <b>Frase de escritura</b> personaliza lo que ven los demás cuando estás escribiendo,
            como "está hilando una respuesta" en lugar del "está escribiendo" de siempre.
          </li>
        </Bullets>

        <Heading>Conteos históricos de publicaciones</Heading>
        <P>
          Tu perfil muestra el total histórico de tus mensajes de chat, temas de foro y respuestas
          publicadas. Solo suben. Eliminar un mensaje no resta al conteo, así que los totales son
          un retrato de largo plazo de cuánto has escrito, no una foto del momento.
        </P>

        <Heading>Visibilidad y NSFW</Heading>
        <P>
          En la pestaña <b>Privacidad</b> puedes marcar el perfil como público (cualquiera puede
          leerlo) o visible solo con sesión iniciada. La casilla <b>NSFW</b> esconde el perfil tras
          un aviso de contenido y lo limita a visitantes con sesión.
        </P>
      </>
    ),
  },

  bonds: {
    title: "Vínculos (títulos mutuos): matrimonio, parejas, familia, amistades",
    body: (
      <>
        <P>
          Un <b>vínculo</b> es una etiqueta de relación que conecta dos perfiles - cosas como
          "Casado con", "Pareja de", "Familia", "Amigo de". Los vínculos aparecen en la sección{" "}
          <b>Vínculos</b> de ambos perfiles. Son <i>mutuos</i> - las dos partes deben aceptar antes
          de que el vínculo aparezca.
        </P>
        <Heading>¿Y esto para qué?</Heading>
        <Bullets>
          <li>Deja que las visitas de un perfil vean de un vistazo con quién está conectado alguien dentro de la ficción.</li>
          <li>Cada vínculo enlaza al otro perfil - un clic y ya estás leyendo su historia.</li>
          <li>Al ser solo mutuos, nadie puede alegar una relación que la otra mitad no aceptó.</li>
        </Bullets>
        <Heading>Proponer un vínculo</Heading>
        <Steps>
          <li>Decide qué tipo de vínculo encaja: <K>marriage</K>, <K>mate</K>, <K>family</K>, <K>friend</K>, etc.</li>
          <li>
            Usa <K>/request {`<kind>`} {`<name>`}</K> - por ejemplo <K>/request marriage @Sigrid</K>.
            La otra persona ve un aviso para aceptar o rechazar.
          </li>
          <li>
            Cuando acepta, el vínculo aparece en ambos perfiles. Si rechaza, no se muestra nada y
            puedes intentar con otro tipo o conversarlo primero.
          </li>
        </Steps>
        <Heading>Terminar un vínculo</Heading>
        <P>
          Cualquiera de las dos partes puede disolver un vínculo en cualquier momento con{" "}
          <K>/dissolve {`<kind>`} {`<name>`}</K>, o <K>/dissolve {`<name>`}</K> para borrar todos
          tus vínculos con esa persona. Al otro lado no se le pregunta - disolver es unilateral,
          como en la vida real.
        </P>
        <Heading>Vínculos de personaje vs de cuenta principal</Heading>
        <P>
          Los vínculos se atan al perfil que esté <b>activo</b> cuando propones. Así, el matrimonio
          de un personaje con otro personaje vive en los perfiles de los personajes, no en las
          cuentas principales detrás. Para un vínculo OOC, suelta a tu personaje primero
          (<K>/char clear</K>) y luego propón.
        </P>
      </>
    ),
  },

  messages: {
    title: "Mensajes directos y amigos",
    body: (
      <>
        <P>
          Un mensaje directo (MD) es un chat privado de uno a uno. Queda solo
          entre tú y la otra persona, y vive en tu bandeja de Mensajes aunque
          estén en salas distintas.
        </P>

        <Heading>Abre tu bandeja de Mensajes</Heading>
        <Steps>
          <li>Abre el panel de <b>Herramientas</b> y elige <b>Mensajes</b>.</li>
          <li>O haz clic en el pequeño ícono de sobre junto a tu nombre, arriba del botón de Herramientas.</li>
          <li>O haz clic en <b>💬 Mensaje</b> en la parte de arriba del perfil de alguien.</li>
        </Steps>
        <P>
          La bandeja muestra tus amigos y tus conversaciones recientes a la
          izquierda. Toca una para abrir el chat a la derecha. En el celular,
          al tocar una conversación el chat ocupa la pantalla; las pestañas de
          arriba te regresan a la bandeja.
        </P>

        <Heading>Agrega un amigo</Heading>
        <Steps>
          <li>Escribe su nombre de usuario en <b>agregar amigo</b>, al final de la bandeja.</li>
          <li>Le llega un aviso con botones de Aceptar / Rechazar.</li>
          <li>Si acepta, ambos aparecen en la lista de amigos del otro.</li>
        </Steps>
        <P>
          También puedes hacerlo con <K>/friend {`<name>`}</K> en el chat.
          <K>/friends</K> muestra tu lista y <K>/unfriend {`<name>`}</K> termina
          una amistad.
        </P>

        <Heading>Escríbele a alguien que no es tu amigo</Heading>
        <P>
          No hace falta ser amigos para enviarse un MD. Escribe su nombre de
          usuario en <b>escríbele a alguien</b>, al final de la bandeja, o haz clic en{" "}
          <b>💬 Mensaje</b> en su perfil. La conversación aparece
          bajo <b>Recientes</b>.
        </P>

        <Heading>Una bandeja por identidad</Heading>
        <P>
          Los MD siguen a la identidad que estés interpretando. Enviar un mensaje con un personaje
          activo inicia una conversación entre ese personaje y la identidad activa de quien lo
          recibe. Volver a tu cuenta principal cambia qué bandeja ves, y los mensajes que envió tu
          personaje no se ven ahí. Si llevas una conversación OOC larga con alguien, suelta a tu
          personaje antes de abrirla.
        </P>

        <Heading>Desactivar los MD</Heading>
        <P>
          Si prefieres no recibir MD, abre el editor de tu perfil, ve a{" "}
          <b>Privacidad</b> y desactiva <b>Mensajería directa</b>. Quien intente
          escribirte verá un aviso amable de "esta persona tiene los MD
          desactivados".
        </P>

        <Heading>Notificaciones y sonidos</Heading>
        <P>
          Un MD nuevo suena con un "ping" suave. El ícono de Mensajes muestra un
          numerito con los MD sin leer y las solicitudes de amistad pendientes.
          Puedes apagar el ping en tu perfil, en{" "}
          <b>Privacidad</b> &rarr; <b>Efectos de sonido</b>.
        </P>

        <Heading>Corrige un error</Heading>
        <P>
          Durante un minuto después de enviar un MD, puedes editarlo o eliminarlo.
          Después, lo enviado, enviado está.
        </P>
      </>
    ),
  },

  safety: {
    title: "Tu comodidad: ignorar y bloquear",
    body: (
      <>
        <P>
          Dos herramientas te dejan controlar quién te alcanza. Tienen fuerzas distintas, y elegir
          la correcta importa.
        </P>

        <Heading>Ignorar (unidireccional, reversible)</Heading>
        <P>
          <K>/ignore {`<name>`}</K> oculta los mensajes de esa persona de <i>tu</i> vista. No se le
          avisa, y ella todavía puede verte. Es un silencioso "prefiero no leer esto por ahora" y
          es un interruptor: úsalo de nuevo para dejar de ignorar.
        </P>
        <Bullets>
          <li><K>/ignore</K> a secas muestra (y te deja limpiar) tu lista de ignorados.</li>
          <li>También puedes abrir la lista desde el panel de Herramientas, en Personas.</li>
          <li>Sirve para: un canal ruidoso, un chat lleno de spoilers, alguien a quien solo quieres bajarle el volumen un rato.</li>
        </Bullets>

        <Heading>Bloquear (mutuo, en todas partes)</Heading>
        <P>
          <K>/block {`<name>`}</K> es la fuerte. Tú y esa persona, y <i>cada</i> personaje que
          cualquiera de los dos interprete, se vuelven invisibles entre sí en todas partes: chat,
          lista de usuarios, susurros, MD, amigos, perfiles y búsqueda. No se le notifica que
          ocurrió.
        </P>
        <Bullets>
          <li>Es mutuo y completo, no un "silencio". Úsalo cuando quieras a alguien fuera de tu experiencia por completo.</li>
          <li>No es un interruptor. Levántalo con <K>/unblock {`<name>`}</K> o desde Perfil, luego Privacidad.</li>
          <li><K>/block</K> a secas lista a todos los que has bloqueado.</li>
          <li>
            Los moderadores y admins no se pueden bloquear, deben seguir visibles para hacer su
            trabajo. Si el problema es alguien del equipo, usa los contactos de la página de reglas.
          </li>
        </Bullets>

        <Heading>¿Cuál elegir?</Heading>
        <P>
          Usa <b>ignorar</b> cuando solo quieras bajar el volumen y quizá cambies de idea. Usa{" "}
          <b>bloquear</b> cuando quieras una separación limpia y mutua que se sostenga en cada sala
          y con cada personaje. Ambos se guardan en tu cuenta, así que te siguen sin importar qué
          personaje interpretes.
        </P>
        <Heading>Protecciones por edad</Heading>
        <P>
          El sitio también cuida por su cuenta a los miembros más jóvenes. Las cuentas de menores
          de 18 nunca ven salas, perfiles, temas de foro ni historias marcadas 18+, y los adultos
          pueden elegir ocultarse ese contenido también. Cómo funciona todo se cubre en la
          siguiente guía, <b>Configuración de edad y contenido 18+</b>.
        </P>
        <Tip label="Consejo">
          Si alguien rompe las reglas, bloquear te protege pero no avisa a los mods. Repórtalo
          también (la página de reglas dice cómo) para que el equipo pueda actuar por todos, no
          solo por ti.
        </Tip>
      </>
    ),
  },

  "age-settings": {
    title: "Configuración de edad y contenido 18+",
    body: (
      <>
        <P>
          Al crear una cuenta ingresas tu fecha de nacimiento. Esa única respuesta decide qué
          partes del sitio puede ver tu cuenta. La ingresas una vez, y puedes verla después en el
          editor de tu perfil, en <b>Privacidad</b>. Si está mal, contacta al equipo. Solo el
          equipo puede corregir una fecha de nacimiento, así nadie puede cambiarse la edad de ida y
          vuelta.
        </P>

        <Heading>Si tienes menos de 18</Heading>
        <P>
          El sitio oculta el contenido adulto de tu cuenta. Ocurre solo; no es una opción que
          tengas que buscar ni activar:
        </P>
        <Bullets>
          <li>
            <b>Las salas 18+</b> no aparecen en tu lista de salas, y los enlaces hacia ellas se
            niegan amablemente a abrirse.
          </li>
          <li>
            <b>Los perfiles marcados 18+</b> muestran un aviso corto en lugar del perfil.
          </li>
          <li>
            <b>Los temas de foro con etiqueta NSFW</b> quedan fuera de los tableros, las búsquedas
            y las notificaciones para ti.
          </li>
          <li>
            <b>Las historias maduras</b> del Scriptorium (clasificación R o NC-17) quedan fuera del
            catálogo y no se pueden abrir.
          </li>
          <li>
            <b>Los mundos 18+</b> se ocultan del catálogo de mundos y no se pueden abrir.
          </li>
        </Bullets>
        <P>
          Todo se levanta solo cuando cumples 18. Cierra sesión y vuelve a entrar el día de tu
          cumpleaños y el sitio te trata como adulto desde entonces.
        </P>

        <Heading>Si tienes 18 o más</Heading>
        <P>
          Por defecto puedes verlo todo. Si prefieres navegar sin contenido adulto, abre el editor
          de tu perfil, ve a <b>Privacidad</b> y activa <b>Ocultar contenido 18+</b>. Oculta los
          temas de foro y resultados de búsqueda 18+, y deja los mundos, foros y comunidades 18+
          fuera de los catálogos y las páginas de descubrimiento. Puedes cambiarlo cuando quieras.
        </P>

        <Heading>Marcar una sala como 18+</Heading>
        <P>
          Los propietarios y mods de una sala pueden volverla solo para adultos escribiendo{" "}
          <K>/nsfw on</K> en ella. Revierte con <K>/nsfw off</K>; un <K>/nsfw</K> a secas solo
          informa el estado actual. Mientras una sala es 18+, los miembros menores de 18 no pueden
          verla, entrar ni leer su historial, y lo escrito durante ese tiempo queda oculto para
          ellos aunque la sala vuelva después a todas las edades. Solo los adultos pueden usar el
          comando.
        </P>

        <Heading>Etiquetar un tema de foro como NSFW</Heading>
        <P>
          Cuando publiques un tema que es para adultos, marca <b>Marcar este tema como NSFW (18+)</b>{" "}
          en el editor. Los temas etiquetados se ocultan a los miembros menores de 18 y a quienes
          activaron Ocultar contenido 18+. Los propietarios y mods del foro pueden agregar o quitar
          la etiqueta en un tema existente si se pasó por alto.
        </P>

        <Tip label="Consejo">
          Marcar las cosas con honestidad mantiene a todos cómodos. Si llevas una sala adulta o
          escribes temas adultos, activa las marcas. Toma un segundo, y significa que nadie cae en
          contenido que no quería ver.
        </Tip>
      </>
    ),
  },

  "worlds-create": {
    title: "Mundos: crear uno (tu propia wiki)",
    body: (
      <>
        <P>
          Un <b>mundo</b> es una wiki privada para tu ambientación - lore, facciones, lugares, NPC.
          Cada mundo tiene un árbol de <b>páginas</b> anidadas hasta 10 niveles. Eres dueño y
          editor de cada mundo que creas; nadie más puede editar tus páginas.
        </P>
        <Heading>Tres niveles de visibilidad</Heading>
        <Bullets>
          <li>
            <b>Privado</b> - solo tú lo ves. Bueno para borradores o para notas personales que no
            quieres compartir.
          </li>
          <li>
            <b>Oculto</b> - cualquiera con la URL o con un enlace desde una sala puede leerlo.
            No aparece en el catálogo. Bueno para mundos de "compartir con mi grupo".
          </li>
          <li>
            <b>Público</b> - listado en el Catálogo de mundos, y otros pueden unirse a tu mundo y
            enlazarlo a sus propias salas. Úsalo para ambientaciones comunitarias donde quieres
            que jueguen otros.
          </li>
        </Bullets>
        <Heading>Crea tu primer mundo</Heading>
        <Steps>
          <li>Abre el panel de <b>Herramientas</b> (abajo a la derecha de la barra) y elige <b>Mis mundos</b>.</li>
          <li>Haz clic en <b>+ Nuevo mundo</b>. Completa el nombre y (si quieres) un slug para la URL.</li>
          <li>Elige una visibilidad inicial - puedes cambiarla en cualquier momento desde el editor.</li>
          <li>Guarda. Caes directo en el editor.</li>
        </Steps>
        <Heading>Agrega páginas</Heading>
        <Steps>
          <li>En la barra lateral izquierda del editor, presiona <b>+ Página</b> para una página de primer nivel, o pasa el cursor sobre una existente y haz clic en <b>+</b> para agregarle una hija.</li>
          <li>Ponle un título a la página. El slug se deriva solo del título; cámbialo si quieres una URL más limpia.</li>
          <li>
            Escribe el cuerpo en HTML (la misma lista permitida que tu biografía: <K>b</K>,{" "}
            <K>i</K>, <K>p</K>, <K>ul</K>, <K>ol</K>, <K>blockquote</K>, <K>h3</K>-<K>h6</K>,
            etc.). Guarda cuando esté lista.
          </li>
          <li>Reordena con el campo <b>Orden</b>, o mueve una página bajo otro padre con el menú <b>Página padre</b>.</li>
        </Steps>
        <Heading>Tema del mundo</Heading>
        <P>
          En el editor del mundo, la sección <b>Tema</b> te deja elegir una paleta de colores
          propia para la ventana de tu mundo. Útil para marcar el tono de un mundo de fantasía
          oscura frente a uno luminoso de recuentos de la vida. El tema aplica <b>solo</b> cuando
          alguien abre tu mundo - nunca se derrama sobre el chat ni la lista de usuarios.
        </P>
        <Tip label="Consejo">
          Los mundos son completamente tuyos. Eliminar uno arrasa con cada página y quita cualquier
          enlace de sala. No hay deshacer, solo una ventana de confirmación - así que piénsalo dos
          veces con mundos privados que llevas meses construyendo.
        </Tip>
      </>
    ),
  },

  "worlds-vibe": {
    title: "Mundos: barras de ambiente y filtros del catálogo",
    body: (
      <>
        <P>
          Cada mundo puede llevar sus <b>barras de ambiente</b>: ocho controles que muestran, de un
          vistazo, qué clase de ambientación es. Las barras son Combate, Magia, Tecnología,
          Romance, Política, Misterio, Terror y Exploración. Cada una va de discreta a dominante.
        </P>
        <Heading>Ajustarlas como autor</Heading>
        <P>
          En el editor del mundo, abre el panel <b>Ambiente</b> y arrastra las barras. Un Romance
          alto y un Combate bajo dicen "esto es un drama pausado, no un campo de batalla". Dejar
          barras en cero está bien. El ambiente aparece en la página de tu mundo.
        </P>
        <Heading>Leerlas como jugador</Heading>
        <P>
          En el <b>Catálogo de mundos</b>, la fila de filtros te deja acotar mundos por ambiente.
          ¿Buscas ambientaciones con mucha magia, poca tecnología y misterio al frente? Sube esas
          barras y el catálogo esconde lo que no coincida. Puedes limpiar los filtros con un clic.
        </P>
        <Tip label="Consejo">
          El ambiente es una pista, no un contrato. Les da a las visitas nuevas una idea del tono
          antes de leer el lore.
        </Tip>
      </>
    ),
  },

  "worlds-join": {
    title: "Mundos: unirse a uno (declara tu afiliación)",
    body: (
      <>
        <P>
          Puedes <b>unirte</b> a un mundo para decir que tu personaje pertenece ahí. Unirse es solo
          una afiliación. No cambia a qué salas puedes entrar ni qué puedes hacer.
        </P>
        <Heading>Tres tipos de puertas</Heading>
        <Bullets>
          <li>
            Los mundos <b>abiertos</b> dejan que cualquiera se una con un clic.
          </li>
          <li>
            Los mundos <b>por solicitud</b> te piden responder unas preguntas primero. El autor del
            mundo revisa tus respuestas y aprueba o rechaza. Si te rechazan, puedes solicitar de
            nuevo más tarde.
          </li>
          <li>
            A los mundos <b>solo con invitación</b> el autor agrega miembros directamente. No hay
            botón público para unirse. Si quieres entrar, escríbele al autor.
          </li>
        </Bullets>
        <Heading>Cómo unirte</Heading>
        <Steps>
          <li>
            <b>Desde el catálogo</b>: panel de Herramientas y luego <b>Catálogo de mundos</b>. Haz
            clic en <b>Unirse</b> en un mundo abierto, o en <b>Solicitar</b> en uno por solicitud.
            El formulario se abre con las preguntas del autor; completa lo que puedas y envíalo.
          </li>
          <li>
            <b>Desde el visor del mundo</b>: la etiqueta del encabezado dice <b>Unirse</b>,{" "}
            <b>Solicitar</b>, <b>Solicitud pendiente</b> o <b>Solo con invitación</b>, según lo que
            el mundo permita.
          </li>
          <li>
            <b>Por comando</b>: <K>/world join {`<slug>`}</K> te une a un mundo abierto. En un
            mundo por solicitud, el mismo comando abre el visor del mundo con el formulario de
            solicitud encima. En uno solo con invitación, recibes un aviso rápido explicando que el
            mundo es solo con invitación.
          </li>
        </Steps>
        <Heading>Una membresía por identidad</Heading>
        <P>
          Tu cuenta principal y cada uno de tus personajes llevan sus propias membresías de mundos.
          Cambiar a un personaje cambia qué mundos aparecen bajo tu nombre. Si quieres que un
          personaje pertenezca a un mundo, cambia a él primero y luego únete. Aprobar una solicitud
          agrega solo a la identidad que solicitó, no a todo tu elenco.
        </P>
        <Heading>Tiempos de la solicitud</Heading>
        <P>
          Después de enviar una solicitud, la tarjeta del mundo muestra <b>Solicitud pendiente</b>{" "}
          y esperas la revisión del autor. Puedes <b>retirar</b> una solicitud pendiente desde la
          tarjeta del catálogo para quedar libre e intentarlo de nuevo más tarde. No hay plazo
          automático; el autor revisa cuando puede.
        </P>
        <Heading>Abandonar un mundo</Heading>
        <P>
          Haz clic en <b>Abandonar</b> en el visor, o usa <K>/world leave {`<slug>`}</K>. La
          membresía de esa identidad desaparece; puedes volver a unirte después si el mundo lo
          permite.
        </P>
        <Tip label="Consejo">
          Unirse es independiente del acceso a las salas. Puedes sentarte en la sala de un mundo
          sin unirte nunca al mundo, y unirte a un mundo sin pisar jamás una de sus salas. Sirven
          para cosas distintas.
        </Tip>
      </>
    ),
  },

  "worlds-application": {
    title: "Mundos: unirse a un mundo por solicitud",
    body: (
      <>
        <P>
          Algunos mundos piden una solicitud antes de unirte. El autor revisa tu solicitud y
          decide. Esta guía recorre el proceso completo.
        </P>
        <Heading>Encuentra y solicita</Heading>
        <Steps>
          <li>Abre el <b>Catálogo de mundos</b> desde el panel de Herramientas.</li>
          <li>
            Los mundos que aceptan solicitudes muestran un botón <b>Solicitar</b> en lugar de{" "}
            <b>Unirse</b>.
          </li>
          <li>
            Haz clic en <b>Solicitar</b>. Se abre un formulario con las preguntas del autor, hasta
            cinco. Cada respuesta puede ocupar un par de páginas.
          </li>
          <li>Completa lo que puedas y envíala.</li>
        </Steps>
        <P>
          Si el mundo no tiene preguntas, el formulario es corto y puedes enviarlo tal cual.
        </P>
        <P>
          El comando también funciona: <K>/world join {`<slug>`}</K> en un mundo por solicitud abre
          el mismo formulario sobre el visor del mundo.
        </P>
        <Heading>Después de enviarla</Heading>
        <P>
          La tarjeta del mundo cambia a <b>Solicitud pendiente</b>. El autor ve tus respuestas en
          el panel de revisión de su mundo, junto a las de todos los que solicitaron hace poco.
          Puedes <b>retirar</b> una solicitud pendiente desde la tarjeta del catálogo si quieres
          dar un paso atrás y solicitar de nuevo más tarde con mejores respuestas.
        </P>
        <Heading>Aprobada</Heading>
        <P>
          La tarjeta cambia a <b>Miembro</b>. La identidad con la que solicitaste se agrega a los
          miembros del mundo. Marca el mundo como tu principal en el visor si quieres que te
          agrupe en las listas de usuarios del chat.
        </P>
        <Heading>Rechazada</Heading>
        <P>
          La tarjeta muestra el rechazo junto con la nota que haya dejado el autor. Puedes
          solicitar de nuevo más tarde. Toma la nota como retroalimentación, no como palabra final.
        </P>
        <Heading>Una solicitud por identidad</Heading>
        <P>
          Las solicitudes siguen a tu identidad. Si solicitaste como un personaje, solo ese
          personaje se agrega al aprobarse. Para llevar a otro personaje al mismo mundo, cambia a
          él primero y solicita por separado.
        </P>
        <Tip label="Consejo">
          La solicitud es el único camino público a un mundo por solicitud; no hay puerta trasera
          por el catálogo ni por el visor. Si el autor pide un contexto que no quieres escribir en
          público, el catálogo también te deja enviarle un MD primero.
        </Tip>
      </>
    ),
  },

  "worlds-attach": {
    title: "Mundos: vincular uno a una sala",
    body: (
      <>
        <P>
          Una sala puede tener <b>un</b> mundo vinculado. Al vincularlo, aparece un pequeño banner
          sobre el chat con el nombre del mundo; al hacer clic se abre la wiki. Los visitantes
          nuevos reciben contexto de la ambientación sin que nadie tenga que explicarla.
        </P>
        <Heading>¿Quién puede vincular?</Heading>
        <P>
          Solo el <b>propietario</b> de la sala o un <b>mod</b> (o un admin del sitio) puede
          vincular o desvincular un mundo. Así se evita que cualquier visitante de paso los cambie.
        </P>
        <Heading>Vincular un mundo tuyo</Heading>
        <Steps>
          <li>
            Entra a la sala que quieres vincular (tienes que estar en la sala para usar el
            comando).
          </li>
          <li>
            Ejecuta <K>/world link {`<slug>`}</K> con el slug de uno de tus mundos (p. ej.{" "}
            <K>/world link darkrealm</K>).
          </li>
          <li>El banner aparece de inmediato para todos en la sala.</li>
        </Steps>
        <Heading>Vincular el mundo de otra persona</Heading>
        <P>
          Solo puedes hacerlo cuando su mundo tiene visibilidad <b>pública</b>, de modo que aparece
          en el catálogo. El comando rechaza a propósito vincular mundos ajenos; se hace desde el
          catálogo, que es el punto de control:
        </P>
        <Steps>
          <li>Abre el panel de <b>Herramientas</b> y luego el <b>Catálogo de mundos</b>.</li>
          <li>
            Busca el mundo. Su fila tiene un botón <b>Usar en esta sala</b> si estás en una sala
            que puedes moderar.
          </li>
          <li>Haz clic y el banner aparece en la sala.</li>
        </Steps>
        <Heading>Desvincular</Heading>
        <P>
          <K>/world unlink</K> quita el vínculo actual (solo propietario/mod/admin). Reemplazar un
          mundo por otro toma un solo paso: <K>/world link {`<other-slug>`}</K> sobrescribe el que
          estaba.
        </P>
        <Heading>Lo que el vínculo no hace</Heading>
        <Bullets>
          <li>No une a los visitantes al mundo automáticamente. Cada quien decide unirse.</li>
          <li>No cambia quién puede hablar en la sala. El acceso se define aparte (pública/privada).</li>
          <li>
            No reparte permisos de edición. Solo el autor del mundo puede editar páginas, junto con
            quienes haya agregado como <b>colaboradores</b>. Mira la guía "Mundos: invitar
            colaboradores".
          </li>
        </Bullets>
        <Heading>Menciona un mundo en el chat con @world:slug</Heading>
        <P>
          Puedes soltar una etiqueta clicable de un mundo en cualquier mensaje escribiendo{" "}
          <K>@world:{`<slug>`}</K>, por ejemplo <K>@world:ironreach</K>. Se muestra como una
          píldora resaltada; a quien haga clic le abre el visor del mundo. Útil para "buscando RP
          en @world:ironreach esta noche" sin tener que vincular el mundo a la sala.
        </P>
        <Tip label="Consejo">
          Mencionar un mundo no notifica a nadie (a diferencia de <K>@username</K>) y no cambia tu
          afiliación ni la de la sala. Es un enlace y nada más.
        </Tip>
      </>
    ),
  },

  "worlds-collaborators": {
    title: "Mundos: invitar colaboradores",
    body: (
      <>
        <P>
          Un mundo tiene un solo autor, pero el autor puede invitar <b>colaboradores</b> para
          ayudar a construirlo. Los colaboradores aparecen junto al autor en la configuración del
          mundo.
        </P>
        <Heading>Agregar un colaborador</Heading>
        <Steps>
          <li>Abre el editor del mundo y elige el panel de <b>Colaboradores</b>.</li>
          <li>Agrega a alguien por nombre. Entra de inmediato; no hay paso de aceptación.</li>
        </Steps>
        <Heading>Qué pueden hacer los colaboradores</Heading>
        <Bullets>
          <li>Editar cualquier página del mundo.</li>
          <li>Ver las páginas a las que tienen acceso aunque estén ocultas en modo privado.</li>
          <li>
            No pueden cambiar la configuración del mundo, como la visibilidad, el modo de unión o
            el borrado. Eso queda en manos del autor.
          </li>
        </Bullets>
        <Heading>Quitar un colaborador</Heading>
        <P>
          En el mismo panel, quita a quien ya no quieras que edite. Sus ediciones existentes se
          conservan; solo termina su acceso.
        </P>
        <Tip label="Consejo">
          La colaboración es por identidad. Invita a la cuenta principal si quieres que la persona
          siga colaborando sin importar qué personaje esté usando. Invita a un personaje específico
          si solo quieres la voz de ese personaje en las notas de tu mundo.
        </Tip>
      </>
    ),
  },

  "worlds-knowledge-base": {
    title: "Mundos: la Base de conocimiento (gente, lugares, arcos, sesiones)",
    body: (
      <>
        <P>
          El <b>Lore</b> de un mundo son páginas libres, ideales para prosa y textos largos. La
          <b> Base de conocimiento</b> es la otra mitad: <b>entradas</b> estructuradas para las
          piezas de tu ambientación, para que tú (y tus jugadores) puedan consultar "quién es este
          NPC" o "qué es esta ciudad" en un toque, sin recorrer una página de wiki.
        </P>

        <Heading>Dos tipos de contenido</Heading>
        <Bullets>
          <li>
            <b>Páginas de Lore</b>, el árbol de páginas anidadas de las guías de Mundos de arriba.
            Ideal para ensayos, historia, reglas, todo lo que se lee de arriba abajo.
          </li>
          <li>
            <b>Entradas</b>, registros cortos con tipo: <b>NPC</b> (gente), <b>Ubicaciones</b>{" "}
            (lugares), <b>Objetos</b> (cosas), <b>Facciones</b> (grupos) y los{" "}
            <b>tipos personalizados</b> que agregues (hechizos, naves, casas, lo que tu
            ambientación necesite). Cada entrada tiene nombre, cuerpo y etiquetas.
          </li>
        </Bullets>

        <Heading>Explorarla como jugador</Heading>
        <P>
          Abre un mundo y cambia a su Base de conocimiento. Un panel muestra los totales de un
          vistazo, y luego puedes explorar las mismas entradas de cuatro formas:
        </P>
        <Bullets>
          <li><b>Por tipo</b>, todos los NPC, todas las ubicaciones, etcétera.</li>
          <li><b>Por etiqueta</b>, todo lo que hayas etiquetado, como "villano" o "ciudad portuaria".</li>
          <li><b>Por arco</b>, entradas agrupadas bajo un arco argumental (mira abajo).</li>
          <li><b>Por sesión</b>, lo que apareció en cada registro de sesión de juego.</li>
        </Bullets>

        <Heading>Enlaces cruzados entre entradas</Heading>
        <P>
          Dentro de cualquier entrada o página de Lore, escribe una etiqueta de enlace como{" "}
          <K>@kind:slug</K>, por ejemplo <K>@npc:sigrid</K> o <K>@location:ironreach</K>. Se
          muestra como una etiqueta clicable que salta directo a esa entrada. Arma una red de
          gente, lugares y grupos que se referencian entre sí, sin copiar y pegar URLs.
        </P>

        <Heading>Arcos y sesiones</Heading>
        <Bullets>
          <li>
            Los <b>arcos</b> son hilos de historia ("El asedio de Ironreach"). Vincula los NPC,
            lugares y sesiones involucrados para repasar el arco completo con un clic.
          </li>
          <li>
            Las <b>sesiones</b> son registros de juego real. Anota qué pasó y qué entradas
            aparecieron, y la Base de conocimiento puede mostrar tu mundo sesión por sesión, útil
            para retomar una partida larga donde la dejaste.
          </li>
        </Bullets>

        <Heading>Agregar contenido como autor</Heading>
        <Steps>
          <li>Abre tu mundo en el editor (panel de Herramientas, luego Mis mundos).</li>
          <li>
            Agrega una entrada, elige su tipo (o define antes un tipo personalizado), ponle nombre,
            escribe el cuerpo y etiquétala.
          </li>
          <li>Vincúlala a un arco, o anótala en una sesión, si pertenece a uno.</li>
          <li>Suelta etiquetas <K>@kind:slug</K> en el cuerpo para conectarla con entradas relacionadas.</li>
        </Steps>
        <Tip label="Consejo">
          No tienes que usar todo esto. Un mundo pequeño puede vivir solo de páginas de Lore.
          Recurre a entradas, arcos y sesiones cuando la ambientación crezca tanto que "¿dónde
          anoté eso?" se vuelva una pregunta real.
        </Tip>
      </>
    ),
  },

  rooms: {
    title: "Salas: encontrar, entrar y crear la tuya",
    body: (
      <>
        <P>
          Las salas son donde ocurren las conversaciones. Cada sala tiene sus propios ocupantes,
          tema, descripción y (opcionalmente) un mundo vinculado.
        </P>
        <Heading>Encuentra una sala</Heading>
        <Bullets>
          <li><b>Barra lateral</b> - la barra de la derecha lista todas las salas públicas con su número de ocupantes. Haz clic en cualquiera para entrar.</li>
          <li><b><K>/list</K></b> imprime todas las salas en el chat (útil si quieres una lista para copiar y pegar).</li>
          <li><b><K>/find {`<name>`}</K></b> busca por fragmento del nombre. Útil cuando recuerdas un pedazo del nombre pero no todo.</li>
        </Bullets>
        <Heading>Cambia de sala</Heading>
        <P>
          Haz clic en el nombre de una sala en la barra lateral o ejecuta <K>/go {`<name>`}</K>.
          Al entrar a una sala privada se pide contraseña (o se acepta una invitación si alguien te
          la dio).
        </P>
        <Heading>Crea tu propia sala</Heading>
        <Steps>
          <li>
            Ejecuta <K>/private {`<name>`} {`<password>`}</K>. Eres su propietario desde el momento
            en que existe.
          </li>
          <li>
            Define un <b>tema</b> con <K>/topic ...</K> (el titular corto sobre el chat) y una{" "}
            <b>descripción</b> con <K>/describe ...</K> (la prosa más larga que ven los visitantes
            nuevos al entrar).
          </li>
          <li>
            Invita a usuarios específicos con <K>/invite {`<username>`}</K> - se saltan la
            contraseña.
          </li>
          <li>
            Si quieres, vincula un mundo: <K>/world link {`<slug>`}</K>.
          </li>
        </Steps>
        <Heading>Banners de escena</Heading>
        <P>
          Propietarios y mods pueden montar una escena con <K>/scene {`<title>`}</K>. Un banner de
          escena aparece sobre el chat, como "En la taberna al atardecer". Termina la escena con{" "}
          <K>/scene end</K>.
        </P>
        <P>
          Para darle una imagen a la escena, agrega una barra vertical y la URL de una imagen
          después del título: <K>/scene The Long Road | https://example.com/road.jpg</K>. La imagen
          llena el fondo del banner. Sin la barra, el banner es solo texto.
        </P>
        <Heading>Herramientas de moderación (solo propietario / mod / admin)</Heading>
        <P>
          Las comunes: <K>/kick</K>, <K>/mute</K>, <K>/ban</K> (con duración opcional), <K>/promote</K>{" "}
          para volver mod a un miembro, <K>/demote</K> para revertirlo. La referencia completa está
          en la pestaña Comandos.
        </P>
        <P>
          Mods y admins también tienen <K>/incognito</K>, que los oculta de la lista de usuarios
          mientras observan. Mira la guía Modo incógnito para las reglas completas.
        </P>
        <Heading>Modos de visualización por sala</Heading>
        <P>
          Dos opciones a nivel de sala ajustan cómo se comporta el chat en esa sala específica.
          Ambas vienen desactivadas / en modo plano. Solo propietario/mod.
        </P>
        <Bullets>
          <li>
            <K>/expiry {`<minutes>`}</K> - los mensajes con más de N minutos se borran solos en la
            siguiente pasada de limpieza. <K>/expiry off</K> lo desactiva. Útil para salas de
            "Buscando RP" donde los avisos viejos deben limpiarse solos.
          </li>
          <li>
            <K>/replymode nested</K> - las respuestas se agrupan bajo su mensaje padre en un hilo,
            con las últimas 5 visibles y un botón "Ver más" para el resto. <K>/replymode flat</K>
            {" "}vuelve a la línea cronológica normal. Combina muy bien con <K>/expiry</K> para
            salas tipo cartelera.
          </li>
        </Bullets>
        <Heading>Salas estilo foro: páginas dentro de categorías</Heading>
        <P>
          Cuando una sala está en modo anidado se comporta como un foro: cada mensaje de primer
          nivel es un tema, las respuestas se agrupan debajo y los temas se ordenan por actividad
          reciente. Dentro de cada categoría hay una tira de paginación numerada al fondo,{" "}
          <b>Anterior</b>, una lista de números de página y <b>Siguiente</b>. Los temas fijados
          siempre quedan arriba en la página 1 y no cuentan para el total por página.
        </P>
        <P>
          El tamaño de página lo define el equipo, así que la tira refleja lo que hayan ajustado
          para tu comunidad. Un tema nuevo siempre cae en la página 1, y si estás leyendo la página
          3 cuando llega uno, la píldora de "X temas nuevos" se queda quieta hasta que vuelvas;
          pasar de página no se interrumpe por la actividad en vivo.
        </P>
        <Tip label="Consejo">
          Un banner de escena es solo decoración. No bloquea la sala ni limita quién puede
          publicar; monta el escenario y todos siguen escribiendo como siempre.
        </Tip>
      </>
    ),
  },

  "communities-join": {
    title: "Comunidades: unirse y descubrir",
    body: (
      <>
        <P>
          Una comunidad (también llamada servidor) es un espacio propio dentro de The Spire, con
          sus propias salas, su propio estilo y sus propios miembros. The Spire es la comunidad
          principal a la que todos pertenecen; encima de eso, la gente puede levantar sus propias
          comunidades para un gremio, el mundo de un juego, un fandom o cualquier grupo que quiera
          un hogar propio.
        </P>
        <P>
          Puedes pertenecer a todas las comunidades que quieras y saltar entre ellas cuando gustes.
          Cada una mantiene sus salas y miembros por separado, así que lo que pasa en una se queda
          en una.
        </P>

        <Heading>Encuentra tus comunidades</Heading>
        <P>
          Busca la franja delgada de íconos redondos a un lado de la pantalla. Esa es tu barra de
          comunidades. Cada ícono redondo es una comunidad a la que perteneces, y la comunidad
          principal también vive ahí. La barrita que se ilumina al borde de un ícono muestra en
          cuál estás ahora, y un puntito sobre un ícono significa que hay actividad nueva que no
          has visto.
        </P>
        <Tip label="Consejo">
          Salta entre las comunidades a las que te uniste haciendo clic en sus íconos de la barra.
          Al hacer clic caes directo en la sala principal de esa comunidad.
        </Tip>

        <Heading>Explora y descubre</Heading>
        <P>
          Al fondo de la barra hay un botón que abre Descubrir, una lista navegable de comunidades
          a las que puedes unirte.
        </P>
        <P>
          Arriba, Descubrir muestra Tus comunidades para saltar rápido. Debajo está la zona para
          explorar con dos listas, Populares y Nuevas, para ver qué está activo y qué acaba de
          abrir. También hay un buscador para encontrar una comunidad por nombre y etiquetas
          clicables (como alta fantasía, ciencia ficción o 18+) para filtrar por tema.
        </P>
        <Tip label="Consejo">
          Las comunidades privadas no aparecen en Descubrir a propósito. Llegas a ellas con un
          enlace directo que alguien comparte (una dirección <K>/s/</K>) o con un código de
          invitación.
        </Tip>

        <Heading>Las tres formas de unirse</Heading>
        <P>
          Cada comunidad define cómo entran los recién llegados. Una pequeña insignia en cada
          tarjeta de Descubrir te dice cuál usa:
        </P>
        <Bullets>
          <li>
            <b>Abierto a todos</b> - cualquiera con sesión iniciada puede unirse al instante. Solo
            haz clic en Unirse en la tarjeta y ya estás dentro.
          </li>
          <li>
            <b>Por solicitud</b> - envías una nota corta y el propietario (o sus mods) te aprueba.
            Haz clic en Solicitar, escribe una o dos líneas sobre por qué quieres unirte si gustas,
            y envíala. Recibirás un aviso cuando se decida, y la tarjeta muestra Solicitud enviada
            mientras esperas.
          </li>
          <li>
            <b>Solo con invitación</b> - la comunidad está oculta y se entra con un código. Haz
            clic en Ingresar código en la tarjeta, pega el código que te dieron y listo.
          </li>
        </Bullets>
        <Tip label="Consejo">
          Para una comunidad cerrada a nuevos miembros, cada tarjeta tiene un enlace por
          &lt;propietario&gt;. Haz clic para abrir el perfil del propietario y escribirle para
          preguntar cómo unirte.
        </Tip>

        <Heading>Elige tu comunidad predeterminada</Heading>
        <P>
          En cualquier comunidad a la que pertenezcas, el botón de estrella en su tarjeta la marca
          como tu predeterminada. Tu predeterminada es la comunidad cuyo estilo llevas en tu
          perfil: tu rango ahí, tu estilo de nombre, tu borde y tu colección. Toca la estrella otra
          vez para quitarla y volver a la comunidad principal.
        </P>
      </>
    ),
  },

  "communities-create": {
    title: "Administrar tu propia comunidad",
    body: (
      <>
        <P>
          ¿Quieres un espacio completamente tuyo: la sede de un gremio, la base del mundo de un
          juego, el rincón privado de un grupo? Puedes solicitar levantar una comunidad y volverte
          su propietario. Como propietario le das forma a sus salas, decides cómo se une la gente,
          eliges su estilo y la cuidas día a día.
        </P>

        <Heading>Solicita levantar una</Heading>
        <Steps>
          <li>
            Abre Descubrir desde el fondo de la barra de comunidades y haz clic en Crea tu
            servidor.
          </li>
          <li>
            Elige un nombre y una dirección web corta (la parte después de <K>/s/</K>). El
            formulario comprueba que la dirección esté libre mientras escribes, y la dirección es
            permanente para que los enlaces compartidos nunca se rompan.
          </li>
          <li>
            Escribe una nota corta sobre para qué es tu comunidad. Los moderadores del sitio la
            leen al revisar.
          </li>
          <li>Si hay reglas que aceptar antes de solicitar, marca la casilla y envía.</li>
        </Steps>
        <Tip label="Consejo">
          Solo puedes tener una solicitud en la fila a la vez, y hay una espera corta para volver a
          solicitar si una se rechaza, así que da tu mejor impresión. Si se rechaza verás la nota
          del revisor y podrás ajustar e intentarlo de nuevo.
        </Tip>

        <Heading>Cuando te aprueben</Heading>
        <P>
          Tu comunidad aparece en el catálogo contigo como propietario. Ábrela desde la barra y usa
          el engrane sobre su ícono para abrir tu configuración de propietario. Todo lo de abajo
          vive ahí, organizado en pestañas. Solo ves las pestañas de lo que puedes administrar.
        </P>

        <Heading>Ajústala a tu manera</Heading>
        <P>Desde tu configuración puedes:</P>
        <Bullets>
          <li>
            <b>Resumen</b> - define el nombre, un lema, una descripción más larga y las etiquetas
            de tema por las que la gente busca. Aquí también eliges cómo se une la gente (abierto a
            todos, por solicitud o solo con invitación) y si los visitantes sin sesión pueden leer
            el lugar.
          </li>
          <li>
            <b>Apariencia</b> - agrega un ícono redondo, un banner en la parte superior, un logo
            ancho, tus propios colores y un tema. Tu estilo aplica solo a tu comunidad; nunca
            cambia el chat de nadie.
          </li>
          <li>
            <b>Salas</b> - crea salas, renómbralas, define su tema, ajusta cuánto tiempo se guardan
            los mensajes y elimina las que ya no necesites.
          </li>
          <li>
            <b>Reglas y configuración</b> - escribe tu bienvenida y las reglas de la casa, y define
            límites como cuánto duran los mensajes y cuánto tiempo hay para editar un mensaje.
          </li>
        </Bullets>

        <Heading>Miembros, equipo y roles</Heading>
        <P>
          Eres el propietario, así que tienes todos los poderes. Para repartir el trabajo puedes
          nombrar ayudantes y organizar a tus miembros:
        </P>
        <Bullets>
          <li>
            <b>Miembros</b> - ve a todos los que se han unido, promueve a alguien a ayudante o
            quítalo.
          </li>
          <li>
            <b>Equipo</b> - nombra un Moderador o un Admin. Un Moderador es tu ayudante del día a
            día que cuida el chat; un Admin maneja casi todo por ti.
          </li>
          <li>
            <b>Roles</b> - agrupa beneficios (como publicar, imágenes o invitar a otros) y un
            color, y entrégaselos a la gente. Todos empiezan con un rol predeterminado; puedes
            crear roles con nombre a mano o poner reglas para que la gente gane un rol
            automáticamente (por ejemplo, después de cierto número de mensajes). Los miembros
            pueden elegir algunos roles por sí mismos, un rol puede verse como insignia en la lista
            de usuarios y las salas pueden limitarse a ciertos roles.
          </li>
          <li>
            <b>Solicitudes</b> - cuando tu comunidad se une por solicitud, aprueba o rechaza a
            quienes esperan en la puerta, con una nota opcional.
          </li>
        </Bullets>

        <Heading>Moderación a tu manera</Heading>
        <P>
          Tú decides exactamente cuánto puede hacer cada ayudante. Al nombrar un Moderador eliges
          sus poderes uno por uno, así que un ayudante solo tiene el alcance que tú le des. Un
          Moderador empieza con un conjunto sensato para ordenar el chat (atender reportes,
          expulsar y silenciar, limpiar mensajes ajenos), y puedes agregar o quitar poderes
          individuales en cualquier momento.
        </P>
        <P>
          Un Admin es un ayudante más completo que puede llevar la administración diaria por ti:
          miembros, salas, roles y más. Lo único que un Admin nunca puede hacer es cambiar el
          estilo de tu comunidad, y solo tú puedes nombrar a un Admin o transferir la comunidad.
        </P>
        <P>
          Ningún ayudante, sin importar cómo lo configures, puede tocar tus propios mensajes ni
          cambiar la apariencia de tu comunidad. Eso queda en tus manos.
        </P>
        <Bullets>
          <li>
            <b>Banear a alguien</b> - un baneo cubre solo las salas de tu comunidad, nunca el resto
            de The Spire. Hazlo con tiempo para que se levante solo al vencer, o permanente. Puedes
            agregar un motivo y levantar un baneo después.
          </li>
          <li>
            <b>Silenciar o expulsar</b> - herramientas más discretas para una sola sala cuando
            alguien solo necesita enfriarse.
          </li>
          <li>
            <b>Registro de moderación</b> - una lista continua de cada acción de moderación en tu
            comunidad, la más reciente primero, para que tú y tus ayudantes vean quién hizo qué.
          </li>
        </Bullets>
        <Tip label="Consejo">
          Cada poder que otorgas se verifica de nuevo tras bambalinas, y a un ayudante nunca se le
          puede entregar un poder que tú no tengas. Ante la duda, empieza a un ayudante como
          Moderador con el conjunto predeterminado y suma más solo conforme le tengas confianza.
        </Tip>

        <Heading>Pasar el mando</Heading>
        <P>
          Si algún día quieres que otra persona administre la comunidad, puedes transferir la
          propiedad a un miembro. Tú bajas a Admin y conservas tu alcance de moderación, pero la
          comunidad pasa a ser suya. Solo tú puedes hacerlo, y después no puedes deshacerlo, así
          que elige con cuidado.
        </P>
        <Tip label="Consejo">
          Comparte tu comunidad con su dirección <K>/s/</K>. Quien la reciba cae directo en tu
          portada, listo para leer o unirse.
        </Tip>
      </>
    ),
  },

  forums: {
    title: "Foros: leer y publicar",
    body: (
      <>
        <P>
          El chat en vivo se va desplazando. Los foros son para la escritura que quieres conservar
          y retomar con los días: anuncios, fichas de personaje, lore del mundo, hilos largos de
          fuego lento. Cada foro es un pequeño espacio propio con sus tableros, su guardián y su
          propio estilo.
        </P>
        <P>
          Un mapa rápido de las palabras. Un foro contiene <b>tableros</b> (como "Discusión
          general" o "Buscando RP"). Un tablero contiene <b>temas</b> (hilos individuales). Un tema
          contiene la publicación inicial y las respuestas de todos. Los tableros se agrupan en{" "}
          <b>categorías</b> para mantener el orden.
        </P>

        <Heading>Abre el Catálogo de foros</Heading>
        <P>
          El número en el botón del Catálogo de foros es tu contador de no leídos: respuestas y
          citas que te esperan. El panel de Herramientas también lista los foros que posees o has
          visitado como atajos rápidos, para tener tus rincones habituales a un toque.
        </P>
        <Bullets>
          <li>Haz clic en la fila <b>Catálogo de foros</b> fijada justo arriba de la lista de salas a la derecha.</li>
          <li>O abre el panel de <b>Herramientas</b> y elige <b>Catálogo de foros</b>.</li>
          <li>O escribe <K>/forums</K>. Agrega un nombre para entrar directo, como <K>/forums spire</K>.</li>
        </Bullets>

        <Heading>Ubícate</Heading>
        <P>
          Elige un foro de la lista a la derecha. El foro propio de The Spire va fijado primero,
          luego los foros a los que perteneces, y el resto bajo Explorar. Usa el botón Descubrir
          (la brújula) para buscar cualquier foro por nombre o etiqueta.
        </P>
        <P>
          Un puntito sobre un foro o un tablero significa que algo nuevo pasó desde tu última
          visita. Toca la estrella de arriba para hacer un foro tu predeterminado, el que el
          catálogo abrirá la próxima vez.
        </P>
        <Steps>
          <li>Abre un foro. Sus tableros están agrupados en categorías.</li>
          <li>
            Dentro de un tablero, los temas fijados van arriba y el resto se ordena por respuesta
            más reciente. Cada tema muestra su número de respuestas para ver qué está activo.
          </li>
          <li>
            Haz clic en un tema para leer el hilo completo ahí mismo, sin salir del catálogo. Una
            etiqueta de color (un "prefijo") en un tema te dice qué es de un vistazo, como Noticias
            o RP abierto.
          </li>
        </Steps>

        <Heading>Crear un tema</Heading>
        <P>
          Cuando puedes publicar, el tablero muestra un botón <b>Nuevo tema</b>. Dale un título a
          tu hilo y escribe la publicación inicial con la barra de escritura completa: el mismo
          formato, emoticones y tesauro que tienes en el chat. Si el tablero lo permite, puedes
          adjuntar una encuesta en vez de una publicación simple.
        </P>
        <P>
          Publicas como quien tengas activo: tu personaje si estás en uno, tu yo OOC si no.
        </P>

        <Heading>Responder y los tres estilos de publicación</Heading>
        <P>
          Abre un tema y usa el cuadro de respuesta al fondo. Encima verás hasta tres botoncitos de
          estilo que cambian cómo se lee tu respuesta:
        </P>
        <Bullets>
          <li><b>Decir</b>, una publicación normal con tu voz. El estilo predeterminado.</li>
          <li>
            <b>Acción</b>, un emote, presentado como algo que tu personaje hace en lugar de decir.
          </li>
          <li>
            <b>NPC</b>, habla como un personaje secundario guardado. Eliges cuál NPC de la lista.
            Este solo aparece si el guardián del foro te dejó dar voz a NPC ahí.
          </li>
        </Bullets>
        <Tip label="Consejo">
          Algunos foros solo dejan publicar a miembros aprobados. Siempre puedes leer primero y
          luego solicitar si te convence. Mira la guía "Foros: unirte a uno que pide solicitud".
        </Tip>

        <Heading>Notificaciones y seguimiento</Heading>
        <P>
          La campana en la parte superior del catálogo es tu bandeja del foro. Reúne tres cosas:
          cuando alguien responde a un tema que iniciaste, cuando alguien cita una de tus
          publicaciones y las respuestas nuevas en temas que sigues. Haz clic en cualquier aviso
          para saltar directo a esa publicación.
        </P>
        <Bullets>
          <li>Sigues automáticamente cualquier tema que inicies o donde respondas.</li>
          <li>
            Para seguir un hilo donde no has publicado, ábrelo y toca su campana de seguimiento.
            Toca de nuevo para dejar de seguirlo.
          </li>
          <li>
            El número de no leídos aparece en la campana, en el botón del Catálogo de foros y en la
            fila Foros del panel de Herramientas, así nunca pierdes una respuesta solo porque el
            catálogo esté cerrado.
          </li>
        </Bullets>

        <Heading>Leer y compartir en la web</Heading>
        <P>
          Cada foro tiene su propia dirección web, como <K>/f/spire</K>, y cada tema también.
          Comparte cualquiera donde quieras. Los visitantes caen justo en esa página, y si
          necesitan iniciar sesión, vuelven directo a ella después. Si el guardián activó la
          lectura pública, hasta los visitantes sin sesión pueden explorar los tableros. Publicar
          siempre requiere una cuenta.
        </P>
        <Tip label="Consejo">
          Los foros y las salas de chat son herramientas distintas para ritmos distintos. Usa una
          sala para el ida y vuelta en vivo; usa un tablero del foro para la publicación que
          quieres que la gente siga encontrando la próxima semana.
        </Tip>
      </>
    ),
  },

  "forums-apply": {
    title: "Foros: unirte a uno que pide solicitud",
    body: (
      <>
        <P>
          Hay dos sabores de foros. Los foros abiertos no te piden nada: solo empieza a publicar.
          Los foros por solicitud quieren que el guardián te conozca (o lea una presentación
          rápida) antes de que puedas publicar. Es normal en comunidades muy unidas o temáticas. En
          ambos casos puedes leerlo todo primero y decidir si es para ti.
        </P>

        <Heading>Unirte a un foro abierto</Heading>
        <P>
          En un foro abierto puedes publicar de inmediato, sin unirte. La única vez que verás un
          botón <b>Unirse</b> es cuando el foro tiene dentro un tablero o una categoría solo para
          miembros. Un clic en Unirse desbloquea esas secciones. No hay espera ni revisión.
        </P>

        <Heading>Solicitar en un foro por solicitud</Heading>
        <Steps>
          <li>Abre el foro desde el catálogo y lee un rato.</li>
          <li>
            Donde normalmente publicarías verás <b>Solicita unirte</b>. Haz clic ahí.
          </li>
          <li>
            Se abre un cuadro corto. Puede que el guardián haya escrito una pregunta ("cuéntanos de
            tu personaje", "cómo nos encontraste"). Respóndela y envía. La respuesta es opcional,
            pero una buena ayuda.
          </li>
        </Steps>

        <Heading>Después de solicitar</Heading>
        <P>
          Tu solicitud queda en la fila del guardián y el foro muestra "Tu solicitud está
          pendiente". No hay reloj: el guardián revisa cuando puede. ¿Cambiaste de opinión? Puedes{" "}
          <b>Retirar</b> una solicitud pendiente en cualquier momento.
        </P>
        <Bullets>
          <li>
            <b>Aprobada</b>: ya eres miembro y puedes publicar. Los tableros solo para miembros
            también se desbloquean.
          </li>
          <li>
            <b>Rechazada</b>: verás la nota del guardián, si dejó una. Puedes solicitar de nuevo
            tras una espera corta, así que toma la nota como un consejo amistoso, no una puerta
            cerrada.
          </li>
        </Bullets>

        <Heading>Abandonar</Heading>
        <P>
          ¿Cambiaste de opinión o la historia siguió su curso? Puedes abandonar un foro desde su
          página en cualquier momento. Abandonarlo solo quita tu membresía; tus publicaciones
          pasadas se quedan donde están, y puedes volver a solicitar después si el foro lo permite.
        </P>
        <Tip label="Consejo">
          Unirte a un foro trata solo de ese foro. No cambia tus salas, tus mundos ni nada más en
          The Spire.
        </Tip>
      </>
    ),
  },

  "forums-create": {
    title: "Foros: solicita abrir el tuyo",
    body: (
      <>
        <P>
          ¿Quieres tu propio rincón de The Spire: la sede de un gremio, la base de un juego, un
          espacio de fandom? Puedes solicitar abrir un foro y volverte su guardián. Esta guía cubre
          la solicitud; cuando te aprueben, mira "Foros: administrar el tuyo" para las herramientas
          del día a día.
        </P>

        <Heading>Solicita abrir uno</Heading>
        <P>
          Un par de reglas de la casa: solo puedes custodiar unos pocos foros a la vez, y solo
          puedes tener una solicitud en la fila al mismo tiempo. Si una solicitud se rechaza, hay
          una espera corta antes de volver a solicitar, así que da tu mejor impresión a la primera.
        </P>
        <Steps>
          <li>
            En el Catálogo de foros, haz clic en <b>Crea tu foro</b> (o escribe <K>/forums create</K>).
          </li>
          <li>
            Elige un nombre y un slug corto para la dirección web, la parte de <K>/f/your-slug</K>.
            El formulario comprueba que el slug esté libre mientras escribes.
          </li>
          <li>
            Escribe una o dos oraciones sobre para qué es el foro. El equipo del sitio las lee al
            revisar.
          </li>
          <li>Si el sitio muestra un cuadro de reglas, léelo y marca que aceptas. Luego envía.</li>
        </Steps>

        <Heading>Después de solicitar</Heading>
        <P>
          Tu petición va al equipo del sitio. Recibirás un aviso aquí y en el chat cuando se
          decida. Si se aprueba, tu foro se crea con un tablero inicial y una publicación de
          bienvenida, y te vuelves su guardián. Si se rechaza, verás la nota del revisor, que sirve
          además de guía para un intento más fuerte la próxima vez.
        </P>
        <Tip label="Consejo">
          Comparte tu foro con su dirección <K>/f/your-slug</K> cuando esté en línea. Quien la
          reciba cae directo en tu portada, con inicio de sesión incluido, listo para leer o
          solicitar.
        </Tip>
      </>
    ),
  },

  "forums-admin": {
    title: "Foros: administrar el tuyo",
    body: (
      <>
        <P>
          Cuando tu foro se aprueba, eres su guardián (su propietario). El guardián da forma a los
          tableros, define quién puede publicar, elige el estilo y cuida el lugar día a día. Todo
          lo de abajo vive tras el ícono de engrane en la parte superior de tu foro.
        </P>
        <P>
          No tienes que hacerlo todo tú. Puedes nombrar moderadores y darle a cada uno solo los
          poderes que elijas.
        </P>

        <Heading>Tableros y categorías</Heading>
        <P>Abre el engrane y luego la pestaña <b>Tableros</b>.</P>
        <Bullets>
          <li>
            Los <b>tableros</b> son las secciones principales. Levanta nuevos, renómbralos, dale a
            cada uno una descripción corta y reordénalos. Retira un tablero que ya no necesites y
            se guarda sin perder sus hilos.
          </li>
          <li>
            Las <b>categorías</b> ordenan los temas dentro de un tablero ("Anuncios", "RP
            abierto"). Dale a cada una un nombre, una nota de una línea y un ícono opcional. Puedes
            anidar una categoría bajo otra para un diseño ordenado de dos niveles.
          </li>
          <li>
            Marca un tablero o una categoría como solo para miembros para reservar su contenido a
            los miembros mientras sigue mostrándose (cerrado) para los demás.
          </li>
        </Bullets>

        <Heading>Quién puede publicar</Heading>
        <Bullets>
          <li>
            <b>Abierto</b>: cualquiera con sesión iniciada puede publicar de inmediato. Ideal para
            espacios públicos y acogedores.
          </li>
          <li>
            <b>Por solicitud</b>: la gente solicita y tú la apruebas. Puedes escribir la pregunta
            que responden los solicitantes, y luego revisar la fila en la pestaña Solicitudes y
            aprobar o rechazar con una nota opcional.
          </li>
          <li>
            <b>Lectura pública</b>: un interruptor que deja a los visitantes sin sesión explorar
            tus tableros. Publicar siempre requiere una cuenta. Útil cuando quieres presumir el
            lugar.
          </li>
        </Bullets>

        <Heading>Prefijos (etiquetas de tema)</Heading>
        <P>
          Los prefijos son las etiquetitas de color en los temas, como Noticias, Abierto o Cerrado.
          Abre la pestaña <b>Prefijos</b> para armar tu set: dale a cada uno un texto, un color y
          una nota opcional al pasar el cursor.
        </P>
        <Bullets>
          <li>Limita un prefijo a ciertas categorías para que solo se ofrezca donde corresponde.</li>
          <li>
            Marca un prefijo como solo para el equipo cuando solo tú y tus mods deban poder
            ponerlo, ideal para etiquetas con autoridad como Anuncio.
          </li>
          <li>También puedes dejar que los miembros creen una etiqueta nueva al vuelo mientras publican, si lo activas.</li>
        </Bullets>

        <Heading>Grupos de miembros</Heading>
        <P>
          Los grupos de usuarios te dejan entregar un paquete completo de habilidades a varios
          miembros a la vez, en lugar de uno por uno. Abre la pestaña <b>Grupos de usuarios</b>{" "}
          para crear un grupo, elegir qué puede hacer (crear temas, responder, usar publicaciones
          de acción, insertar imágenes, agregar encuestas y los poderes de moderación que quieras
          incluir) y sumarle gente.
        </P>
        <P>
          Los grupos también pueden llenarse solos. Agrega una regla como "ha publicado al menos 20
          veces" o "lleva 30 días como miembro" y la gente entra al grupo automáticamente al
          calificar, sin que tengas que perseguir a nadie.
        </P>

        <Heading>Moderadores y sus poderes</Heading>
        <P>
          Nombra moderadores desde la pestaña <b>Roles</b> para que te ayuden a cuidar los
          tableros. Lo flexible de los mods del foro es que eliges los poderes de cada uno con
          casillas, así que un ayudante puede fijar y cerrar temas sin poder banear a nadie.
        </P>
        <Bullets>
          <li>
            <b>Poderes de orden</b>: cerrar o reabrir temas, fijarlos arriba, moverlos o
            fusionarlos, y editar o quitar publicaciones de otros miembros.
          </li>
          <li>
            <b>Poderes de confianza</b>: revisar solicitudes de ingreso, administrar miembros,
            manejar los grupos, atender la fila de reportes y banear o desbanear gente.
          </li>
          <li><b>Poderes de voz</b>: dejar que un mod publique como NPC.</li>
          <li>
            Lo único que ningún mod puede hacer, ni con poderes de edición, es tocar tus
            publicaciones como guardián. El foro sigue siendo tuyo.
          </li>
        </Bullets>
        <Tip label="Consejo">
          Los mods nuevos empiezan con los poderes de orden del día a día activados y los delicados
          (banear, administrar miembros) apagados, para que esos los otorgues a propósito.
        </Tip>

        <Heading>Quitar y banear gente</Heading>
        <P>
          Desde la pestaña <b>Miembros</b> puedes quitar a un miembro común. Desde la pestaña{" "}
          <b>Baneos</b> puedes banear a alguien por un día, una semana, un mes o para siempre, con
          un motivo que verá. Un baneo de foro cubre solo tu foro, nunca el resto de The Spire, y
          puedes levantarlo cuando quieras.
        </P>
        <P>
          También puedes banear directo desde el perfil de quien causa problemas: abre su perfil y
          usa <b>Banear del foro</b>. Si administras más de un foro, primero eliges cuál. Es el
          mismo baneo limitado al foro, así que nunca afecta su cuenta en otros lados.
        </P>

        <Heading>Reportes y el registro de moderación</Heading>
        <P>
          Cuando un miembro reporta una publicación, cae en tu pestaña <b>Reportes</b>, donde tú (o
          un mod con ese poder) pueden saltar a la publicación y resolverla o descartarla. La
          pestaña <b>Registro de moderación</b> es un historial continuo de la moderación en tu
          foro, quién cerró, movió o baneó qué, para que tú y tus mods siempre vean cómo se manejó
          una situación.
        </P>

        <Heading>Dar voz a NPC</Heading>
        <P>
          Los NPC son personajes secundarios guardados, un nombre más unas líneas de datos
          opcionales como HP o Ánimo, con los que puedes hablar dentro de un tema. Créalos una vez
          desde la lista de NPC y reutilízalos donde sea. Pertenecen a tu cuenta, así que te siguen
          entre foros.
        </P>
        <P>
          En tu propio foro, decide quién puede dar voz a los NPC entregando el poder de NPC a un
          grupo o a un mod. Cuando alguien lo tiene, un botón NPC aparece junto a Decir y Acción en
          el cuadro de respuesta.
        </P>

        <Heading>Hazlo tuyo</Heading>
        <P>
          En la pestaña <b>Apariencia</b> puedes agregar un banner y un logo, elegir tus propios
          colores, vincular un mundo que hayas construido para que los visitantes lean su lore
          desde el foro y (si administras un servidor de comunidad) atar el foro a él. El estilo
          aplica solo a tu foro; nunca cambia el chat de nadie.
        </P>
        <Tip label="Consejo">
          Comparte tu foro con su dirección <K>/f/your-slug</K>. Quien la reciba cae directo en tu
          portada, listo para leer o solicitar.
        </Tip>
      </>
    ),
  },

  "top-communities": {
    title: "Mejores comunidades",
    body: (
      <>
        <P>
          Mejores comunidades es una cartelera pública de comunidades de rol que vale la pena
          conocer. Piénsala como un directorio amistoso: sitios hermanos, comunidades aliadas y
          otros lugares donde la gente se reúne a escribir, todo en una sola lista navegable.
          Cualquiera puede mirarla, con o sin sesión iniciada.
        </P>
        <P>
          Verás una tarjeta por comunidad con su nombre, una descripción corta, algunas etiquetas y
          un botón Visitar que la abre en una pestaña nueva. Es una forma rápida de encontrar tu
          próximo hogar, saltar entre comunidades que ya amas y descubrir grupos que aún no
          conoces.
        </P>

        <Heading>Cómo abrirla</Heading>
        <P>Hay varias formas fáciles de entrar.</P>
        <Steps>
          <li>Desde la página de inicio, toca la pestaña "Mejores comunidades" en la barra de menú superior.</li>
          <li>
            O baja en la página de inicio hasta el panel "Mejores comunidades de RP" y haz clic en
            "Explorar todas las comunidades" para abrir la cartelera completa.
          </li>
          <li>También puedes ir directo visitando la dirección <K>/top-communities</K>.</li>
        </Steps>

        <Heading>Qué muestra cada tarjeta</Heading>
        <P>Cada entrada de la lista es una tarjeta. Esto es lo que ves.</P>
        <Bullets>
          <li>
            <b>Ícono y nombre</b>: el logo de la comunidad (o un mosaico con su letra) y su título.
          </li>
          <li>
            <b>Descripción</b>: un texto corto sobre de qué va la comunidad. Si es larga, toca "Ver
            más" para leer el resto.
          </li>
          <li>
            <b>Etiquetas</b>: rótulos pequeños del género o el ambiente, como el tipo de rol que
            encontrarías ahí.
          </li>
          <li>
            <b>Dos contadores pequeños</b>: una flecha que apunta abajo a la izquierda muestra las
            visitas que esa comunidad nos envió, y una flecha que apunta arriba a la derecha
            muestra las visitas que le enviamos. Juntas dan una idea aproximada de cuánto tráfico
            fluye entre esa comunidad y aquí.
          </li>
          <li>
            <b>Botón Visitar</b>: abre la comunidad en una pestaña nueva para que no pierdas tu
            lugar en la cartelera.
          </li>
        </Bullets>
        <Tip label="Consejo">
          Las tarjetas abren en pestaña nueva, así puedes asomarte a varias comunidades y volver a
          la cartelera sin perder tu lugar.
        </Tip>

        <Heading>Cómo se ordenan las comunidades</Heading>
        <P>
          De forma predeterminada la cartelera muestra primero las comunidades más activas. "Más
          activas" solo significa las que tienen más visitas entrando y saliendo, así que los
          lugares donde la gente de verdad hace clic suben a los primeros puestos.
        </P>
        <P>No estás atado a ese orden. Usa el menú Ordenar en la parte superior de la cartelera para cambiarlo.</P>
        <Bullets>
          <li><b>Más activas</b>: el orden predeterminado, las más movidas primero.</li>
          <li><b>Más nos envían</b>: las que más visitantes nos mandan.</li>
          <li><b>Más les enviamos</b>: aquellas a las que más visitantes mandamos.</li>
          <li>
            <b>De la A a la Z</b>: orden alfabético simple, útil cuando sabes qué nombre buscas.
          </li>
        </Bullets>

        <Heading>Encontrar una comunidad</Heading>
        <P>
          Si la lista es larga, tienes varias formas de acotarla. Todo se actualiza al instante
          mientras avanzas.
        </P>
        <Steps>
          <li>Escribe un nombre o una etiqueta en el buscador para filtrar la lista mientras escribes.</li>
          <li>
            O haz clic en una de las etiquetas para ver solo comunidades con esa etiqueta. Haz clic
            de nuevo (o en "Quitar etiqueta") para retirar el filtro.
          </li>
          <li>
            Usa las flechas de página al fondo para pasar entre los resultados si hay más de una
            página.
          </li>
        </Steps>
        <Tip label="Consejo">
          La búsqueda y las etiquetas funcionan junto con el orden, así que puedes, por ejemplo,
          filtrar por una etiqueta y aun así mantener las más activas arriba.
        </Tip>

        <Heading>Publica tu propia comunidad</Heading>
        <P>¿Administras tu propia comunidad? Puedes agregarla a la cartelera.</P>
        <P>
          Haz clic en "Agrega tu sitio" (también llamado "Publica tu comunidad") cerca de la parte
          superior de la cartelera. Si tienes sesión iniciada, se abre un formulario corto donde
          llenas el nombre de tu comunidad, una descripción, el enlace que la gente debe visitar y,
          si quieres, un ícono, una imagen de banner y algunas etiquetas. Si aún no has iniciado
          sesión, se te pedirá crear una cuenta primero.
        </P>
        <P>
          Las publicaciones nuevas se revisan antes de salir en vivo, así que tu tarjeta no
          aparecerá en la cartelera de inmediato. Cuando se apruebe, se muestra junto a las demás y
          empieza a acumular visitas.
        </P>
        <Tip label="Consejo">
          Un nombre claro, una descripción amistosa de una línea y un par de etiquetas precisas
          ayudan a que la gente encuentre y elija tu comunidad de un vistazo.
        </Tip>
      </>
    ),
  },

  theater: {
    title: "Salas de Teatro: ver videos juntos",
    body: (
      <>
        <P>
          El Teatro convierte una sala en una función compartida. Un panel de video se coloca sobre
          el chat y todos ven lo mismo al mismo tiempo, mientras la conversación sigue debajo.
          Cualquiera en la sala puede ver y reaccionar; configurarlo es cosa del anfitrión.
        </P>
        <Heading>Actívalo</Heading>
        <P>
          Ejecuta <K>/theater on</K> en la sala. Un panel de video aparece sobre el chat. Apágalo
          cuando quieras con <K>/theater off</K>.
        </P>
        <Heading>Pon videos en la fila</Heading>
        <Steps>
          <li>
            Agrega un video con <K>/theater add {`<link>`}</K>. Funcionan YouTube, Vimeo y enlaces
            directos de video. Agrega los que quieras para armar una lista de reproducción.
          </li>
          <li>
            Mira qué hay en la fila con <K>/theater list</K>, quita uno con{" "}
            <K>/theater remove {`<number>`}</K> o vacía toda la lista con <K>/theater clear</K>.
          </li>
          <li>
            Agregar y quitar videos es silencioso, solo tú ves la confirmación, así que preparar la
            fila no llena la sala de mensajes.
          </li>
        </Steps>
        <Heading>Reprodúcelo para todos</Heading>
        <P>
          Los controles bajo el video, reproducir, pausar, saltar y la barra de progreso, manejan
          la reproducción para toda la sala a la vez. Solo el anfitrión ve los controles; los demás
          siguen la función en sincronía, y quien llega tarde salta directo al punto actual.
        </P>
        <Heading>Repetición</Heading>
        <Bullets>
          <li><K>/theater loop all</K> reproduce toda la lista y vuelve a empezar (lo predeterminado).</li>
          <li><K>/theater loop one</K> repite el video actual.</li>
          <li><K>/theater loop off</K> se detiene al final del último video.</li>
        </Bullets>
        <Heading>Reacciones y tamaño</Heading>
        <P>
          Cualquiera puede tocar el emoji de la barra para hacer flotar una reacción sobre el
          video. Arrastra la agarradera al pie del panel para hacer el video más alto o más bajo y
          darle al chat más o menos espacio.
        </P>
        <Tip label="Consejo">
          ¿Quieres transmitir tu propia pantalla o una película desde tu computadora en vez de un
          enlace? Mira la guía "Teatro: transmitir tu propio video".
        </Tip>
      </>
    ),
  },

  "theater-stream": {
    title: "Teatro: transmitir tu propio video",
    body: (
      <>
        <P>
          Una sala de Teatro muestra un reproductor de video compartido sobre el chat, para que
          todos vean juntos y en sincronía. Además de pegar un enlace de video o una URL de YouTube
          o Vimeo, puedes transmitir tu propia pantalla o un archivo de video desde tu computadora
          con un reproductor gratuito como VLC.
        </P>
        <Heading>Convierte la sala en un teatro</Heading>
        <P>
          Como propietario de la sala o mod, ejecuta <K>/theater on</K>. Un panel de video aparece
          sobre el chat. Puedes poner un video normal en la fila con <K>/theater add {`<link>`}</K>;
          los pasos de abajo cubren transmitir tu propio escritorio.
        </P>
        <Heading>Paso 1: haz que VLC genere un enlace en vivo</Heading>
        <Steps>
          <li>Abre VLC y elige <b>Medio</b>, luego <b>Emitir</b>.</li>
          <li>
            Agrega el archivo de video que quieres reproducir, o elige{" "}
            <b>Dispositivo de captura</b> y pon el modo en <b>Escritorio</b> para compartir tu
            pantalla. Luego haz clic en <b>Emitir</b>.
          </li>
          <li>
            En el paso de destinos elige <b>HLS</b> y agrégalo. Activa la transcodificación y elige
            un perfil que use <b>video H.264 y audio AAC</b>, que es lo que los navegadores pueden
            reproducir.
          </li>
          <li>
            Configura la ruta para que termine en <K>.m3u8</K> (por ejemplo{" "}
            <K>/live/stream.m3u8</K>) e inicia la emisión. VLC ya está sirviendo tu video en un
            puerto de tu computadora.
          </li>
        </Steps>
        <Heading>Paso 2: pon el enlace en línea de forma segura</Heading>
        <P>
          Por ahora tu transmisión vive en tu computadora, y este sitio es seguro, así que un
          enlace local simple no cargará aquí. Usa una app de túnel gratuita para convertirlo en un
          enlace público seguro:
        </P>
        <Bullets>
          <li>
            <b>Cloudflare Tunnel</b> o <b>ngrok</b> son los más fáciles. Apunta cualquiera de los
            dos al puerto que usa VLC.
          </li>
          <li>
            Te da una dirección web segura. Tu enlace de transmisión es esa dirección con tu ruta{" "}
            <K>.m3u8</K> al final, como{" "}
            <K>https://something.trycloudflare.com/live/stream.m3u8</K>.
          </li>
          <li>
            Un ajuste obligatorio: la transmisión tiene que dejar que este sitio la lea. Para
            ngrok, inícialo con{" "}
            <K>ngrok http 8090 --response-header-add "Access-Control-Allow-Origin: *"</K>; en otras
            herramientas, configura el encabezado de respuesta{" "}
            <K>Access-Control-Allow-Origin: *</K>. Sin esto, el reproductor se queda en blanco.
          </li>
        </Bullets>
        <Heading>Paso 3: agrégalo a la sala</Heading>
        <P>
          Ejecuta <K>/theater live {`<your https link>`}</K>. Todos en la sala ven tu transmisión
          de inmediato, marcada como <b>En vivo</b>. Como es en vivo no hay retroceso; quien llega
          tarde salta directo a lo que está pasando ahora.
        </P>
        <Tip label="Consejo">
          El enlace que agregas se muestra a la sala, así que cualquiera puede abrirlo también en
          su propio reproductor. Si el video no aparece, revisa que el enlace empiece con{" "}
          <b>https</b> y que tu túnel y VLC sigan corriendo. OBS también funciona si lo prefieres;
          la idea es la misma, emite HLS y comparte el enlace seguro.
        </Tip>
      </>
    ),
  },

  incognito: {
    title: "Modo incógnito (mods y admins)",
    body: (
      <>
        <P>
          Los mods y admins pueden volverse invisibles mientras observan una sala. Úsalo cuando
          quieras vigilar un problema sin que tu presencia cambie cómo se comporta la gente.
        </P>
        <Heading>Actívalo</Heading>
        <Bullets>
          <li>
            <K>/incognito</K> enciende y apaga el modo incógnito. Mientras está activo, una
            insignia discreta se queda junto a tu cuadro de mensaje para que no lo olvides.
          </li>
          <li>Desapareces de la lista de usuarios para todos, excepto para otros mods y admins.</li>
          <li>Tu indicador de escritura deja de mostrarse. Tu estado de lectura no se transmite.</li>
        </Bullets>
        <Heading>Lo que sigue pasando</Heading>
        <Bullets>
          <li>Puedes leer todos los mensajes con normalidad.</li>
          <li>
            Si publicas o tomas una acción de moderación, vuelves a ser visible en ese momento.
            Hablar rompe la ilusión.
          </li>
          <li>
            Los MD que envías sí llegan. El destinatario los ve tuyos como siempre.
          </li>
        </Bullets>
        <Heading>Desactivarlo</Heading>
        <P>Ejecuta <K>/incognito</K> de nuevo. Tu presencia vuelve a encenderse al instante.</P>
        <Tip label="Consejo">
          El modo incógnito es para moderar. No es una forma de leer un RP privado sin
          consentimiento. Úsalo como lo haría el gerente de un local que camina en silencio por un
          bar concurrido.
        </Tip>
      </>
    ),
  },

  tools: {
    title: "El panel de Herramientas (abajo a la derecha de la barra)",
    body: (
      <>
        <P>
          Cada acción común tiene su botón - no necesitas memorizar comandos. Toca el botón{" "}
          <b>Herramientas</b> al final de la barra para deslizar el panel hacia arriba. Se cierra
          tocando afuera o con <K>Esc</K>.
        </P>
        <P>
          El panel está agrupado en secciones. Cada una permanece plegada hasta que tocas su
          encabezado, así ves una lista corta y ordenada y abres solo lo que necesitas. Abrir una
          sección cierra las demás, y el cuadro de búsqueda de la sala actual vive al final.
        </P>
        <Heading>Qué hay adentro</Heading>
        <Bullets>
          <li><b>Construcción de mundos</b> - Mis mundos, Catálogo de mundos.</li>
          <li><b>Escritura</b> - Mis historias, Scriptorium.</li>
          <li><b>Rol</b> - Establecer ánimo, Establecer escena, interruptor del modo NPC.</li>
          <li>
            <b>Foros</b> - Catálogo de foros, Crear un foro y enlaces rápidos a los foros que son
            tuyos o que visitas. Aquí aparece una insignia cuando tienes respuestas del foro sin
            leer.
          </li>
          <li><b>Salas</b> - Buscar salas, Lista de salas, Nueva sala privada.</li>
          <li><b>Personas</b> - Mensajes (MD + amigos + solicitudes de amistad en una sola ventana), Todos los usuarios, Lista de ignorados. Una pequeña insignia con el conteo sin leer aparece en el botón y en la fila de Mensajes cuando alguien te manda un MD.</li>
          <li><b>Pantalla</b> - Color de chat, Tamaño de letra, Intervalo de actualización.</li>
          <li><b>Cuenta</b> - Editar perfil, Tus Recompensas, Marcadores, Modo ausente, Ayuda.</li>
        </Bullets>
        <P>
          Todo lo que puedes hacer desde el panel también se puede hacer con un comando - el panel
          solo te ahorra teclear.
        </P>
      </>
    ),
  },

  "shortcut-chips": {
    title: "Etiquetas de atajo: {etiquetas} clicables para chat y anuncios",
    body: <NavigationTagsGuideEs />,
  },

  thesaurus: {
    title: "Tesauro: resalta una palabra para ver sinónimos",
    body: (
      <>
        <P>
          ¿Te atoraste con una palabra a mitad de escena? Resáltala en el cuadro de mensaje y
          aparece una lista de sinónimos. Elige uno, reemplaza lo que tenías seleccionado y sigues
          escribiendo.
        </P>
        <Heading>Dónde funciona</Heading>
        <Bullets>
          <li>El cuadro de mensaje principal en cualquier sala.</li>
          <li>El cuadro de texto de tus mensajes directos.</li>
          <li>Los temas y respuestas de los foros.</li>
        </Bullets>
        <Heading>Cómo activarlo</Heading>
        <P>
          Selecciona una sola palabra arrastrando (los apóstrofos y guiones no estorban, así que
          "can't" y "cross-examine" funcionan). Aparece una pequeña lista justo encima del cuadro
          de texto.
        </P>
        <Heading>Usar la ventana emergente</Heading>
        <Bullets>
          <li>Presiona <b>Up</b> o <b>Down</b> para recorrer la lista.</li>
          <li>Presiona <b>Enter</b> o <b>Tab</b> para tomar la palabra resaltada.</li>
          <li>Presiona <b>Esc</b> para cerrarla sin cambiar nada.</li>
          <li>O simplemente haz clic en la palabra que quieras.</li>
        </Bullets>
        <Heading>Qué aparece</Heading>
        <P>
          Palabras sueltas y frases cortas, tomadas de un diccionario de sinónimos integrado. Una
          palabra común como "happy" puede sugerir "cheerful" y "in good spirits" lado a lado. Si
          no aparece nada, la palabra no está en el diccionario; prueba otra forma (p. ej.
          "running" en vez de "run").
        </P>
      </>
    ),
  },

  customization: {
    title: "Personalización: temas, color, ánimo, ausente",
    body: (
      <>
        <P>
          Unos cuantos detalles hacen que el chat se sienta tuyo. Ninguno es obligatorio para
          participar.
        </P>
        <Heading>Tema</Heading>
        <P>
          Abre el selector de temas desde el banner (arriba de la página) para cambiar los colores
          de todo el sitio, solo para ti. No afecta lo que ven los demás.
        </P>
        <Heading>Color de chat</Heading>
        <P>
          <K>/color {"<hex>"}</K> establece el color de <i>tu</i> nombre y tus acciones en el chat.{" "}
          <K>/color clear</K> vuelve al predeterminado. Los personajes activos pueden tener su
          propio color, separado del color de tu cuenta principal.
        </P>
        <Heading>Ánimo</Heading>
        <P>
          <K>/mood {"<text>"}</K> muestra una pequeña etiqueta junto a tu nombre - "melancólico",
          "agotado", "engreído". <K>/mood clear</K> la quita. Perfecto para transmitir un estado
          emocional sin tener que explicarlo en el diálogo.
        </P>
        <Heading>Ausente</Heading>
        <P>
          <K>/away [reason]</K> te marca como ausente (aparece una pequeña etiqueta "[ausente]"
          contigo). <K>/away</K> sin motivo, estando ya ausente, la quita. Mientras estás ausente,
          los sonidos del chat se silencian a propósito para que no vuelvas a una fila de avisos.
        </P>
        <Heading>Frase de escritura</Heading>
        <P>
          La línea que ven los demás cuando escribes (la predeterminada es "está escribiendo") se
          puede personalizar. La frase de escritura es una pequeña compra con Monedas en la tienda;
          cuando ya es tuya, la frase vive en el editor de Adornos de tu perfil. Prueba "está
          tramando una respuesta", "está afilando una pluma" o lo que le quede a tu personaje.
        </P>
        <Heading>Escena (a nivel de sala)</Heading>
        <P>
          Los propietarios y mods pueden establecer una <b>escena</b> con <K>/scene {"<title>"}</K>.
          Un banner corto aparece encima del chat, útil para encuadres tipo "ya estamos en la
          taberna". Termínala con <K>/scene end</K>.
        </P>
        <P>
          Agrega una imagen de fondo a la escena con una barra vertical después del título:{" "}
          <K>/scene El camino largo | https://example.com/road.jpg</K>. La imagen llena el fondo
          del banner. Omite la barra para un banner de solo texto.
        </P>
      </>
    ),
  },

  announcements: {
    title: "Anuncios: la marquesina del banner y publicaciones programadas",
    body: (
      <>
        <P>
          Los admins pueden publicar anuncios que llegan a todas las salas. Hay dos superficies y
          sirven para cosas distintas.
        </P>
        <Heading>La marquesina del banner</Heading>
        <Bullets>
          <li>Está en la parte más alta del chat y va rotando entre los banners activos.</li>
          <li>Los puntos indicadores debajo de la franja saltan directamente entre banners.</li>
          <li>Cierra cualquier banner que ya leíste y no lo volverás a ver. Los demás lo siguen viendo. El descarte es solo tuyo.</li>
        </Bullets>
        <Heading>Anuncios programados en el chat</Heading>
        <P>
          Los admins también pueden programar anuncios que se publican como líneas de chat en las
          salas a una hora específica. Se ven como una línea de <K>/announce</K> normal, pero el
          momento es automático. Los anuncios programados admiten envíos únicos y calendarios
          recurrentes, así que un resumen de RP de los sábados puede repetirse solo cada semana.
        </P>
        <Heading>Difusiones manuales</Heading>
        <P>
          Cualquiera con el rol adecuado puede usar <K>/announce {"<text>"}</K> para una línea de
          chat única y muy visible en la sala actual (o en todo el sitio, si es admin). Es el primo
          manual del flujo programado de arriba.
        </P>
        <Tip label="Consejo">
          Solo los admins pueden publicar en la marquesina del banner. Si tienes algo que compartir
          con toda la comunidad y quieres un lugar en el banner, escríbele a un mod.
        </Tip>
      </>
    ),
  },

  "dice-rolls": {
    title: "Tiradas de dados en línea y modificadores",
    body: (
      <>
        <P>
          Puedes tirar dados en dos lugares: como comando propio con <K>/roll</K>, o en medio de
          una oración con la sintaxis en línea <K>!roll:</K>.
        </P>
        <Heading>Tiradas en línea</Heading>
        <P>
          Escribe la expresión con <K>!roll:</K> y los dados caen justo donde los pusiste. El resto
          de tu mensaje queda intacto alrededor.
        </P>
        <Bullets>
          <li><K>Tenso mi arco !roll:1d20+5 y la flecha vuela.</K></li>
          <li><K>!roll:2d6</K> para el daño.</li>
          <li><K>!roll:1d100-10</K> si tienes una penalización.</li>
        </Bullets>
        <P>
          El modificador puede ser cualquier entero positivo o negativo. El resultado muestra los
          dados tirados y el número final después de aplicar el modificador.
        </P>
        <Heading>Comando completo</Heading>
        <P>
          <K>/roll {"<expression>"}</K> difunde a la sala una línea de tirada limpia, sin texto
          alrededor. Útil para resolver combates donde quieres que el resultado se sostenga solo.
        </P>
        <Tip label="Consejo">
          Si juegas con un sistema que necesita totales visibles, mete las tiradas en línea para
          que la conversación se lea natural. Si estás pidiendo una prueba, usa el <K>/roll</K>{" "}
          independiente para que tenga peso.
        </Tip>
      </>
    ),
  },

  polls: {
    title: "Encuestas: pregúntale algo a la sala",
    body: (
      <>
        <P>
          Una encuesta es una votación rápida que sueltas en el chat. La sala ve la pregunta y las
          opciones, toca para votar y mira cómo se llenan los resultados en vivo.
        </P>
        <Heading>Crea una</Heading>
        <P>
          Escribe la pregunta y luego cada opción, separadas por una barra vertical <K>|</K>.
          Necesitas al menos dos opciones.
        </P>
        <Bullets>
          <li><K>/poll ¿Mejor estación? | Primavera | Verano | Otoño | Invierno</K></li>
        </Bullets>
        <Heading>Opciones que puedes agregar</Heading>
        <P>
          Pon cualquiera de estas marcas justo después de <K>/poll</K>, antes de la pregunta:
        </P>
        <Bullets>
          <li><K>--multi</K> permite que cada votante elija más de una opción.</li>
          <li><K>--secret</K> oculta quién votó por qué; solo se ven los totales.</li>
          <li>
            <K>--for 2h</K> cierra la encuesta automáticamente después de un tiempo. Usa <K>30m</K>,{" "}
            <K>2h</K> o <K>1d</K>. Aun así puedes cerrarla a mano antes.
          </li>
        </Bullets>
        <Bullets>
          <li><K>/poll --multi ¿Snacks para la noche de película? | Papas | Palomitas | Fruta</K></li>
          <li><K>/poll --secret --for 1d ¿Quién debería liderar la incursión? | Sigrid | Kaal</K></li>
        </Bullets>
        <Heading>Votar y ver resultados</Heading>
        <P>
          Toca una opción en la tarjeta de la encuesta para votar; toca de nuevo para cambiar de
          opinión mientras siga abierta. Las barras se actualizan para todos en tiempo real. A
          menos que la encuesta sea secreta, puedes ver quién eligió qué. Cuando la encuesta cierra
          (por su temporizador, o cuando quien la creó la cierra), el conteo final queda fijo.
        </P>
        <Tip label="Consejo">
          Las encuestas también funcionan en los foros. El editor de publicaciones del foro tiene
          una opción de encuesta, así que un tema del tablero puede ser una votación ("¿qué noche
          les queda para la sesión?") que los miembros responden a lo largo de días, no de
          segundos.
        </Tip>
      </>
    ),
  },

  earning: {
    title: "Recompensas: XP, Monedas, rangos y cosméticos",
    body: (
      <>
        <P>
          Recompensas es la capa de premios a largo plazo por ser parte de la comunidad. Cada
          mensaje de chat, publicación en el foro y rato tranquilo de presencia en una sala te da{" "}
          <b>Experiencia (XP)</b> y <b>Monedas</b> en paralelo; la XP hace crecer tu <b>rango</b>{" "}
          (el emblema que aparece junto a tu nombre) y las Monedas se quedan en tu billetera para
          gastarlas en estilos de nombre, bordes de avatar y otros cosméticos.
        </P>
        <P>
          Abre <b>Recompensas</b> desde el banner superior para ver tu billetera, el progreso de tu
          rango, el registro de actividad y todo lo que hay para comprar.
        </P>

        <Heading>Cómo ganas</Heading>
        <Bullets>
          <li>
            <b>Mensajes de chat</b> en una sala; el texto debe tener varios caracteres, así que un
            simple "ok" no cuenta.
          </li>
          <li>
            <b>Publicaciones y respuestas del foro</b> en salas en modo anidado.
          </li>
          <li>
            <b>Presencia</b>: mantenerte activo en una sala otorga un poco cada pocos minutos, con
            un tope diario. "Activo" significa que publicaste o recorriste el historial en ese
            bloque.
          </li>
        </Bullets>
        <P>
          Cuando publicas <i>como personaje</i>, lo ganado se acredita al fondo de ese personaje;
          los canales OOC y las publicaciones del foro se acreditan a tu cuenta principal. Cada
          fondo tiene su propio rango. Puedes subir de nivel a tu personaje favorito y mantener
          aparte el rango de tu cuenta principal.
        </P>

        <Heading>Comandos</Heading>
        <Bullets>
          <li>
            <K>/currency</K>, muestra tu billetera (cuenta principal + personaje activo).
          </li>
          <li>
            <K>/currency [user]</K>, mira el saldo de otro usuario (respeta su opción de
            privacidad).
          </li>
          <li>
            <K>/currency send [target] [amount]</K>, envía Monedas a otro usuario O personaje.
            Sujeto a topes diarios y a requisitos de antigüedad de cuenta que define el admin.
          </li>
          <li>
            <K>/exp</K>, muestra tu XP, rango y grado. Si alcanzaste el máximo de algún rango
            (grado IV: Verified), la línea también lista qué bordes puedes comprar.
          </li>
          <li>
            <K>/exp [user]</K>, consulta el rango de otro usuario. El rango siempre es público.
          </li>
        </Bullets>

        <Heading>Rangos y grados</Heading>
        <P>
          El escalafón trae seis rangos de forma predeterminada: New Arrival, Active, Recognized,
          Established, Distinguished y Legacy Member. Cada uno tiene cuatro grados (I, II, III y
          IV: Verified, el máximo). Al cruzar a un nuevo grado aparece un listón discreto en la
          parte superior del chat ("alcanzaste Recognized III") que puedes descartar. Llegar al
          grado IV de cualquier rango desbloquea la compra del <b>marco de borde</b> de ese rango.
        </P>
        <P>
          Tu <b>emblema</b>, la pequeña insignia junto a tu nombre en el chat, la lista de usuarios
          y las publicaciones del foro, siempre refleja tu rango/grado actual. Se actualiza solo.
        </P>

        <Heading>Cosméticos que puedes comprar</Heading>
        <Bullets>
          <li>
            <b>Estilos de nombre</b>, degradado, brillo, pulso, paneo y más. Cómpralos en la
            sección Estilos de nombre del panel de Recompensas, personaliza los colores y
            equípalos. Tu nombre con estilo aparece en el chat, la lista de usuarios y las
            publicaciones del foro. Los colores se mantienen legibles tanto en temas claros como
            oscuros.
          </li>
          <li>
            <b>Bordes de rango</b>, marcos circulares que envuelven tu avatar. Disponibles solo
            cuando alcanzaste el grado IV del rango en cuestión. Puedes tener varios y elegir cuál
            mostrar.
          </li>
          <li>
            <b>Bordes libres</b>, bordes decorativos que no piden rango. Se venden en la pestaña{" "}
            <b>Bordes</b> del panel de Recompensas, en su propia sección de estilo libre, junto a
            los bordes de rango. Tienen sus propios efectos (plumas de fénix, llama de hogar y
            demás) y se equipan aparte de los bordes de rango.
          </li>
          <li>
            <b>Avatar en línea en el chat</b>, una vez comprado, tu avatar redondo aparece después
            de la hora en cada línea del chat. También reemplaza al ícono de género en la lista de
            usuarios como el punto donde se hace clic para abrir tu perfil.
          </li>
          <li>
            <b>Transiciones de sala</b> (donde estén disponibles), animaciones cortas que se
            reproducen cuando cambias de sala de chat (y al moverte por los foros). Cómpralas y
            equípalas en el panel de Recompensas, por identidad, igual que los estilos de nombre,
            para que un personaje haga su propia clase de entrada.
          </li>
          <li>
            <b>Adornos de perfil</b>, la marquesina de citas, el contador de visitas y la frase de
            escritura son pequeñas compras con Monedas que personalizan tu perfil. Revisa la guía
            sobre crear tu perfil para ver qué hace cada una.
          </li>
        </Bullets>

        <Heading>Gasta en objetos y emoticones de la comunidad</Heading>
        <P>
          Las Monedas también alimentan la tienda de objetos (galletas, peluches, mascotas y otros
          coleccionables; mira la guía de objetos) y pagan a los creadores en el mercado de
          emoticones (una Moneda por cada uso de una hoja cuyo artista tenga el comercio activado).
          La tienda y el selector de emoticones muestran el costo por adelantado, así nada es
          silencioso.
        </P>

        <Heading>Privacidad</Heading>
        <P>
          Abre <b>Recompensas → Configuración</b> para ocultar tu total de Monedas a otros usuarios
          (o desde la pestaña Privacidad del editor de perfil). Tu rango y tu XP siguen visibles;
          el rango está pensado como una seña de identidad pública.
        </P>

        <Tip label="Consejo">
          ¿Recién llegas? A Recompensas te apuntas participando, no haciendo clic en nada. Solo
          chatea con normalidad y verás tu primer rango en una o dos sesiones.
        </Tip>
      </>
    ),
  },

  items: {
    title: "Objetos, tienda, mascotas y colecciones",
    body: (
      <>
        <P>
          Las Monedas que ganas se gastan en <b>objetos</b> en la tienda: galletas, peluches,
          herramientas, mascotas y lo que sea que el equipo admin haya puesto en los estantes. Los
          objetos viven en un inventario por identidad: tu cuenta principal y cada uno de tus
          personajes guardan el suyo.
        </P>

        <Heading>Explorar y comprar</Heading>
        <Bullets>
          <li>
            <K>/shop</K>, abre la pestaña Tienda dentro del panel de Recompensas. Igual que
            Recompensas ▸ Objetos ▸ Tienda.
          </li>
          <li>
            <K>/item &lt;name&gt;</K>, abre la tarjeta a pantalla completa de cualquier objeto del
            catálogo. Acepta el slug ("cookie"), el nombre visible, el plural o cualquier alias
            definido por el admin.
          </li>
        </Bullets>

        <Heading>Usar objetos en el chat</Heading>
        <Bullets>
          <li>
            <K>/give &lt;name&gt; [num] &lt;item&gt;</K>, entrega objetos a otro usuario de la
            sala. Llegan a la identidad activa del destinatario. La cantidad predeterminada es 1.
            Es la única forma de mover objetos entre dos identidades tuyas: simplemente dátelos a
            ti mismo.
          </li>
          <li>
            <K>/throw &lt;name&gt; [num] &lt;item&gt;</K>, lánzale un objeto a alguien. Es pura
            ambientación: el objeto se consume de tu inventario y el objetivo no recibe nada. Cada
            objeto trae sus propias líneas de lanzamiento aleatorias (definidas por los admins);
            los objetos sin líneas de lanzamiento rechazan la acción.
          </li>
          <li>
            <K>/drop &lt;name&gt; [num] &lt;item&gt;</K>, misma forma que throw, distinta
            ambientación. Ambos comparten una espera de 4 segundos por remitente para que la sala
            no parpadee.
          </li>
        </Bullets>

        <Heading>Fijar en tu perfil</Heading>
        <P>
          Puedes fijar tus favoritos para que otros jugadores los vean en tu perfil.
        </P>
        <Bullets>
          <li>
            <K>/collection</K>, abre tu vitrina de Colección de 10 espacios. Fija cualquier objeto.
          </li>
          <li>
            <K>/pets</K>, abre tu vitrina de Mascotas de 5 espacios. Solo mascotas.
          </li>
        </Bullets>
        <P>
          Ambos conjuntos de fijados son por identidad: la Colección de tu personaje va aparte de
          la de tu cuenta principal. Toca un objeto fijado en el perfil de alguien para abrir su
          tarjeta (igual que <K>/item &lt;name&gt;</K>).
        </P>

        <Heading>Acumular está permitido</Heading>
        <P>
          No hay tope de cuántas unidades de un objeto puedes tener. Compra mil galletas, junta
          quinientos peluches, quédate con cada ovillo de lana que la tienda haya vendido. La
          tienda no te va a frenar, <K>/give</K> no rechaza a un destinatario por "inventario
          lleno", y quien gana una rifa recibe el premio completo sin importar lo que ya tenía. Lo
          mismo aplica a las Monedas de tu billetera.
        </P>

        <Tip label="Consejo">
          Las cantidades en <K>/give</K>, <K>/throw</K> y <K>/drop</K> son opcionales y quedan en
          1 si no las escribes. Si tu identidad activa no tiene el objeto (o no tiene suficientes),
          la acción falla en silencio sin consumir nada.
        </Tip>
      </>
    ),
  },

  "social-games": {
    title: "Juegos sociales: RPS, trivia, dados de historias, duelos y rifas",
    body: (
      <>
        <P>
          Un conjunto de minijuegos dentro del chat para pasar el rato, escribir en grupo, medirse
          en duelos y regalar cosas. Ninguno requiere preparación, todos siguen la regla de
          por-identidad que usa el resto del sitio, y cada acción publica una línea en el chat para
          que los espectadores puedan seguir la partida.
        </P>
        <P>
          <b>Premios:</b> el equipo admin puede, si quiere, asociar XP, Monedas o un objeto de la
          tienda como premio del ganador en cualquiera de estos juegos. El premio aparece en la
          línea de resultado para que la sala vea qué ganó. Las rifas son la excepción: su premio
          ya es lo que puso quien la organizó.
        </P>
        <Tip label="Consejo">
          <K>/games</K> imprime una referencia rápida y privada de todos los juegos sociales y
          cómo iniciarlos. Solo tú ves el resultado, así que puedes abrirla a mitad del chat sin
          llenar la sala de spam.
        </Tip>
        <P>
          <b>Juegos por rondas y el bono de puntos:</b> en los juegos de varias rondas (Letras
          revueltas, abajo), los puntos acumulados del ganador escalan los pagos de XP y Monedas.
          Quien juntó 200 puntos gana 2× la recompensa base, 500 puntos gana 5×, y así hasta un
          tope de 10×. Los premios de objetos (si están configurados) son fijos: ganas el objeto o
          no.
        </P>

        <Heading>Piedra, papel o tijera</Heading>
        <P>
          Una ronda de 30 segundos en la sala actual. Cualquiera puede abrirla; cualquiera puede
          unirse.
        </P>
        <Bullets>
          <li>
            <K>/rps</K> abre una ronda y la anuncia. Después puedes usar <K>/rps rock</K>,{" "}
            <K>/rps paper</K> o <K>/rps scissors</K> en cualquier momento antes de que acabe el
            tiempo. Las formas cortas también sirven: <K>r</K>, <K>p</K>, <K>s</K>.
          </li>
          <li>
            <K>/rps {"<throw>"}</K> funciona como jugada única. Si hay una ronda en curso, tu
            jugada entra en ella. Si no hay ronda, tu jugada abre una nueva contigo como primer
            participante.
          </li>
          <li>
            Cambiar de opinión está bien. Ejecutar <K>/rps</K> otra vez con otra jugada
            sobrescribe tu elección anterior. Lo último que enviaste antes de que acabe el tiempo
            es lo que cuenta.
          </li>
        </Bullets>
        <P>
          <b>Cómo se decide la ronda:</b> las jugadas se agrupan por valor. Si hay dos grupos,
          gana el grupo cuya jugada vence a la otra (papel vence a piedra, piedra vence a tijera,
          tijera vence a papel) y cada miembro del grupo ganador cuenta como ganador. Si están las
          tres jugadas, nadie gana y la ronda se cancela. Si todos lanzaron lo mismo, es empate. El
          mensaje de resultado lista a cada participante con su jugada, así la sala ve la partida
          completa.
        </P>

        <Heading>Trivia</Heading>
        <P>
          Una ronda de trivia de 60 segundos donde quien la abre esconde una respuesta y la sala
          corre a adivinarla.
        </P>
        <Bullets>
          <li>
            <K>/trivia {"<question>"} | {"<answer>"}</K> abre una ronda. La barra vertical (|) es
            el separador. La pregunta se anuncia; la respuesta queda oculta.
          </li>
          <li>
            <K>/answer {"<text>"}</K> envía un intento. Los intentos fallidos reciben un aviso
            privado discreto; el correcto termina la ronda de inmediato, revela la respuesta en
            público y muestra al ganador. La comparación es flexible: ignora mayúsculas y descarta
            un "the / a / an" inicial, así que "Eiffel Tower" y "the eiffel tower" cuentan igual.
          </li>
        </Bullets>
        <P>
          Al final de la ronda, la línea de resultado lista todos los intentos para que los
          espectadores vean quién probó qué. Si nadie acertó, la respuesta se revela cuando el
          tiempo se agota.
        </P>

        <Heading>Dados de historias</Heading>
        <P>
          Una ronda de escritura creativa de 3 minutos. El servidor elige cuatro palabras al azar;
          los jugadores escriben publicaciones IC cortas que entretejan las cuatro. La sala vota
          al ganador con reacciones 📖; no lo decide quien abrió la ronda.
        </P>
        <Bullets>
          <li>
            <K>/storydice</K> abre una ronda. Las cuatro palabras del reto se revelan en la línea
            inicial, cosas como <i>lantern, oath, rust, river</i>.
          </li>
          <li>
            <K>/storydice {"<your post>"}</K> envía un párrafo. Tu publicación cae en el chat como
            una entrada con estilo (un encabezado en negrita "Storydice entry by …" con tu texto
            con sangría debajo) para que no se confunda con la charla normal, y ya trae una
            reacción 📖 sembrada para que el botón de votar quede a la mano.
          </li>
          <li>
            Una participación por identidad. En cuanto publicas quedas comprometido, así que da tu
            mejor esfuerzo.
          </li>
        </Bullets>
        <P>
          <b>Votación:</b> toca la etiqueta 📖 de cualquier participación que te guste (o de todas
          las que quieras apoyar). Al final de la ronda gana la participación con más reacciones
          📖, los empates comparten el premio, y la línea de resultado lista cada entrada con sus
          votos. Las participaciones que no entretejieron las cuatro palabras quedan marcadas, pero
          aún pueden ganar si a la sala le encantaron.
        </P>

        <Heading>Letras revueltas</Heading>
        <P>
          Se elige una palabra, sus letras se revuelven y la sala compite por encontrar cuantas
          palabras del diccionario pueda con esas letras. Los puntos crecen con el largo, y acertar
          la palabra original duplica la puntuación.
        </P>
        <Bullets>
          <li>
            <K>/scramble</K> inicia un juego de 3 rondas en la sala actual. Cada ronda dura
            alrededor de un minuto y saca una palabra nueva.
          </li>
          <li>
            <K>/scramble {"<rounds>"}</K> elige el número de rondas, de 1 a 5. La dificultad sube
            con cada ronda, así que un juego de 5 rondas termina con una palabra fuente mucho más
            larga que la del inicio.
          </li>
          <li>
            <K>/scramble {"<rounds>"} {"<word1>"} {"<word2>"} ...</K> deja que el anfitrión elija
            las palabras fuente de cada ronda. Por ejemplo, <K>/scramble 3 forward accelerate hyperspace</K>{" "}
            corre tres rondas con esas palabras exactas. Si das menos palabras que rondas, las que
            falten se eligen por ti. Las palabras deben tener de 4 a 12 letras, solo letras.
          </li>
          <li>
            <K>/scramble {"<word1>"} {"<word2>"} ...</K> sin número al inicio corre una ronda por
            cada palabra que diste.
          </li>
          <li>
            <K>/scramble {"<word>"}</K> durante una ronda activa reclama puntos por una palabra
            que encontraste. Tu palabra debe tener al menos tres letras, usar solo letras presentes
            en la mezcla (contando repetidas) y aparecer en el diccionario del juego. Repetir una
            palabra en la misma ronda no puntúa dos veces.
          </li>
          <li>
            <K>/scramble status</K> reimprime las letras actuales y el tiempo restante, en privado
            para ti.
          </li>
          <li>
            <K>/scramble cancel</K> termina tu propio juego antes de tiempo. Solo el anfitrión.
          </li>
        </Bullets>
        <P>
          <b>Puntuación:</b> las palabras de 3 letras valen 1 punto, y la escala sube por 3, 6,
          10, 15, 21 y 28 para hallazgos de nueve letras o más. Escribir la palabra fuente sin
          revolver duplica tus puntos por ese hallazgo, que suele ser la jugada más grande de la
          ronda.
        </P>
        <P>
          <b>Varias rondas:</b> la cadena de temporizadores corre de ronda en ronda
          automáticamente. Cada fin de ronda publica una línea rápida de posiciones para que los
          espectadores sigan quién va adelante. Al terminar la última ronda gana la puntuación más
          alta (los empates comparten el premio), y el bono de puntos de los juegos por rondas
          descrito arriba se aplica a la XP y las Monedas del ganador.
        </P>

        <Heading>Duelos</Heading>
        <P>
          Combate 1v1 por turnos con clases, HP y acciones resueltas con dados. Cada tirada queda
          registrada en el chat, así que la pelea se lee como una transcripción.
        </P>
        <Bullets>
          <li>
            <K>/duel {"<opponent>"}</K> reta a alguien con la clase predeterminada (knight). El
            oponente tiene 60 segundos para responder.
          </li>
          <li>
            <K>/duel {"<opponent>"} as {"<class>"}</K> reta a alguien y define <i>tu</i> clase
            para la pelea. Ejemplo: <K>/duel Casey as mage</K> reta a Casey contigo como mago.
            Agrega <K>vs {"<class>"}</K> para sugerirle también una clase a tu oponente: <K>/duel
            Casey as mage vs knight</K>.
          </li>
          <li>
            Si dos jugadores comparten el mismo nombre (un personaje y el personaje de otra
            cuenta), el sistema te muestra un pequeño selector con el token de identidad de cada
            coincidencia. Pega el token correcto de vuelta en el comando para fijar a la persona
            indicada.
          </li>
          <li>
            <K>/duel accept [class]</K> acepta el reto. Elige tu propia clase, knight, archer,
            mage o gunslinger (formas cortas <K>k</K>, <K>a</K>, <K>m</K>, <K>g</K>).
          </li>
          <li>
            <K>/duel decline</K> rechaza el reto.
          </li>
          <li>
            En tu turno, elige <K>/duel attack</K>, <K>/duel defend</K>, <K>/duel parry</K> o{" "}
            <K>/duel rest</K>. Cada acción registra sus tiradas de dados en público. Tienes 60
            segundos por turno o pierdes por abandono.
          </li>
          <li>
            <K>/duel status</K> imprime los HP, las clases, de quién es el turno y el
            temporizador. <K>/duel forfeit</K> es rendirse.
          </li>
        </Bullets>
        <P>
          <b>Las clases:</b> el knight (caballero) tiene la mayor cantidad de HP y una espada
          (daño 1d10+5). El archer (arquero) tiene bono para impactar y un arco (1d8+3). El mage
          (mago) tiene el dado de daño más alto (1d12) pero los HP más bajos. El gunslinger
          (pistolero) hace crítico con 19 o 20, el más propenso a dispararse para un golpe final.
        </P>
        <P>
          <b>La matemática del combate, en corto:</b> los ataques tiran 1d20 + el modificador de
          impacto de la clase contra la defensa del objetivo (12 base, +5 al defenderse, +3 al
          desviar). Los críticos duplican la tirada de daño. El desvío (parry) tiene éxito cuando
          el 1d20 de quien desvía supera la tirada natural del atacante; con éxito, el ataque se
          anula Y quien desvió contraataca con la mitad del daño. Defenderse reduce a la mitad el
          daño recibido. Descansar recupera 2d6 HP pero pierdes tu ataque.
        </P>
        <P>
          <b>Defenderse o desviar, oculto para tu oponente:</b> cuando te defiendes o desvías, la
          sala solo ve "you take a guarded stance" (tomas una postura de guardia); no pueden saber
          cuál elegiste. Tú ves la mecánica exacta en una línea privada de confirmación. Así tu
          oponente tiene que adivinar: atacar contra un desvío dispara el contraataque, pero
          también desperdicias tu postura si el rival decide descansar o ponerse en guardia.
        </P>

        <Heading>Rifas de sala</Heading>
        <P>
          Pon un objeto o algo de Monedas en juego. El premio sale de tu inventario o billetera
          activos de inmediato y vive en la rifa mientras dura. La gente escribe <K>/claim</K> en
          el siguiente minuto para entrar. Al final se elige a un participante al azar y se lleva
          el premio. Si nadie reclama, el premio vuelve a ti.
        </P>
        <Bullets>
          <li>
            <K>/raffle item {"<name>"} [count]</K> rifa un objeto. El nombre puede ser el slug, el
            nombre visible o cualquier alias del admin, igual que <K>/give</K>. La cantidad
            predeterminada es uno.
          </li>
          <li>
            <K>/raffle currency {"<amount>"}</K> rifa Monedas de tu billetera activa.
          </li>
          <li>
            <K>/raffle cancel</K> termina tu propia rifa antes de tiempo y devuelve el premio.
            Solo el anfitrión.
          </li>
          <li>
            <K>/raffle status</K> muestra el premio de la rifa activa, cuántos han reclamado y el
            tiempo restante.
          </li>
        </Bullets>
        <P>
          El sorteo es uniforme y al azar. Incluso un premio de varias unidades ("cinco galletas")
          va a un solo ganador, no se reparte. El anfitrión puede entrar a su propia rifa: tú
          pusiste la apuesta, puedes recuperarla.
        </P>

        <Heading>Reclamar</Heading>
        <P>
          <K>/claim</K> (o <K>/enter</K>) te mete en la rifa activa. La rifa de la propia sala
          tiene prioridad: si la sala donde estás tiene una rifa en curso, <K>/claim</K> se une a
          esa. Si la sala no tiene rifa pero hay una rifa de todo el sitio en marcha,{" "}
          <K>/claim</K> entra a la del sitio. Ejecutar <K>/claim</K> una segunda vez no hace nada;
          una entrada por identidad por rifa.
        </P>

        <Heading>Rifas de todo el sitio (admin)</Heading>
        <P>
          Los admins pueden abrir una rifa para todo el sitio con <K>/announceraffle item {"<name>"} [count]</K>{" "}
          o <K>/announceraffle currency {"<amount>"}</K>. El anuncio se difunde a todas las salas,
          la ventana es de tres minutos (para que la gente en salas ocupadas alcance a verlo), y{" "}
          <K>/claim</K> funciona desde cualquier sala que no tenga su propia rifa activa. Aplican
          las mismas reglas de sorteo al azar y de devolución si nadie entra.
        </P>

        <Heading>Un juego a la vez por sala</Heading>
        <P>
          Solo una sesión de juego social puede correr en una sala en un momento dado. Una ronda
          de piedra, papel o tijera y una rifa no pueden superponerse, y dos rifas no pueden correr
          a la par. La misma regla aplica al espacio de todo el sitio: una rifa anunciada a la vez
          en todo el sitio.
        </P>

        <Heading>Reglas de identidad</Heading>
        <P>
          Todo es por identidad, como el resto del sistema. Tu cuenta principal y cada personaje
          pueden entrar una vez cada uno por ronda. Los objetos y las Monedas salen del fondo de la
          identidad activa; el premio se acredita a la identidad con la que se entró. Si quieres
          rifar el peluche de un personaje, cambia a ese personaje antes de empezar.
        </P>

        <Tip label="Consejo">
          Estar en incógnito desactiva organizar y entrar. Tanto el anuncio inicial como la línea
          de resultado imprimen nombres, lo que arruinaría el propósito de <K>/incognito</K>.
          Vuelve a ser visible primero si quieres participar.
        </Tip>
      </>
    ),
  },

  arcade: {
    title: "El Spire Arcade y el Eidolon Tamer",
    body: (
      <>
        <P>
          El Spire Arcade es un pequeño rincón de juegos, aparte del chat. Ábrelo desde el panel
          de <b>Herramientas</b>, en Cuenta, o desde donde esté enlazado el arcade. El juego
          estelar es el <b>Eidolon Tamer</b>, un familiar de bolsillo que incubas y crías.
        </P>

        <Heading>Tu familiar</Heading>
        <P>
          Incuba un eidolon y se convierte en un pequeño compañero con sus propias estadísticas y
          estados de ánimo. Es una mascota de cuidados a propósito: sus necesidades cambian con el
          tiempo, así que le gusta una visita diaria. Aliméntalo, juega con él y mantenlo feliz y
          descansado. Si lo dejas desatendido demasiado tiempo puede ponerse gruñón o enfermarse,
          como le pasaría a una mascota real, así que pasar a verlo a diario lo mantiene
          floreciente.
        </P>

        <Heading>Un familiar por identidad</Heading>
        <P>
          Como casi todo en The Spire, el eidolon es por identidad. Tu yo OOC y cada personaje
          pueden desbloquear y criar el suyo. El desbloqueo es una compra única con Monedas en esa
          identidad; después, cambiar a esa identidad es la forma de visitar a su familiar.
        </P>

        <Heading>Presúmelo en el chat</Heading>
        <P>
          <K>/eidolon emote</K> publica el ánimo actual de tu familiar en la sala como una acción,
          por ejemplo "Mortis hums with quiet contentment." (Mortis ronronea con serena
          satisfacción). Lee el ánimo en vivo, así que siempre coincide con lo que muestra el
          arcade. Una linda forma de traer a tu mascota a una escena.
        </P>
        <Tip label="Consejo">
          El ritmo de cuidado diario es justamente la gracia del Eidolon Tamer, no una tarea que
          comparta el resto del sitio. Nada más en The Spire decae ni vence por estar ausente; este
          rincón en particular está pensado para premiar un poco de atención constante.
        </Tip>
      </>
    ),
  },

  scriptorium: {
    title: "Scriptorium: ficción de formato largo",
    body: (
      <>
        <P>
          El Scriptorium es la superficie de escritura de formato largo: cuentos, novelas por
          entregas, fanfiction. Las historias viven fuera del chat: tienen capítulos, un códice
          opcional, colaboradores, reseñas, aplausos y una lista de suscriptores.
        </P>

        <Heading>Escribir</Heading>
        <Bullets>
          <li>
            <K>/write</K>, abre el editor en tu borrador editado más recientemente.
          </li>
          <li>
            <K>/write new</K>, lanza el asistente de nueva historia. Elige título, género,
            clasificación y visibilidad.
          </li>
          <li>
            <K>/write &lt;slug&gt;</K>, edita una de tus historias por su slug de URL.
          </li>
        </Bullets>
        <P>
          Cada capítulo tiene su propio estado de publicación (borrador / publicado / abandonado)
          con historial de versiones autoguardado. Si un colaborador ya está en un capítulo, un
          bloqueo suave muestra "Alice está editando, ¿abrir en solo lectura?" para que no se
          sobrescriban el trabajo.
        </P>

        <Heading>Visibilidad y clasificaciones</Heading>
        <Bullets>
          <li>
            <b>Privada</b>, solo tú y los colaboradores invitados pueden verla.
          </li>
          <li>
            <b>Sin listar</b>, cualquiera con la URL puede leerla. No aparece en los catálogos.
          </li>
          <li>
            <b>Pública</b>, aparece en el catálogo de historias y en la estantería de la portada,
            y se puede leer según el filtro de clasificación.
          </li>
        </Bullets>
        <P>
          Las clasificaciones (G / PG / PG-13 / R / NC-17) limitan a los lectores ANÓNIMOS: de G a
          R se pueden leer públicamente; las tarjetas NC-17 aparecen en el catálogo con una
          insignia de candado y requieren una cuenta con sesión iniciada para abrirse. Los lectores
          con sesión ven todo; las listas personales de advertencias de contenido bloqueadas
          (Perfil ▸ Privacidad ▸ Scriptorium) ocultan las historias etiquetadas con advertencias
          que decidiste no ver.
        </P>

        <Heading>Leer</Heading>
        <Bullets>
          <li>
            <K>/scriptorium</K>, abre el catálogo. Pestañas: <b>Buscar historias</b> (todo),
            <b> Mis historias</b> (tus borradores + publicadas), <b>Leyendo</b> (retoma donde te
            quedaste), <b>Siguiendo</b> (tus suscripciones).
          </li>
          <li>
            <K>/story &lt;slug&gt;</K>, abre una historia en el lector.
          </li>
          <li>
            <K>/story &lt;slug&gt; chapter &lt;N&gt;</K>, salta a un capítulo específico.
          </li>
        </Bullets>
        <P>
          El lector ofrece <b>modo libro</b> (columnas paginadas, navegación de pasar página) y{" "}
          <b>modo continuo</b> (un solo desplazamiento, retoma donde te quedaste). Los controles de
          tipografía (fuente, tamaño, interlineado, ancho de columna) y los esquemas de color
          (claro / sepia / oscuro / automático) viven en la barra del lector.
        </P>

        <Heading>Participación de los lectores</Heading>
        <Bullets>
          <li>
            <b>Reseñas + aplausos</b>, una reseña por (lector, historia) con 1–5 estrellas y un
            texto opcional. Los 60 segundos de gracia para editar son como en el chat. Las reseñas
            admiten respuestas. El aplauso es de un toque, uno por lector.
          </li>
          <li>
            <b>Suscríbete</b>, sigue una historia y cada capítulo nuevo publicado te deja una
            notificación en la app.
          </li>
          <li>
            <b>Códice</b>, los autores pueden publicar una biblia por historia (personajes,
            lugares, puntos de trama) que vive junto a la historia. Útil para llevar la
            continuidad sin meterla en la prosa.
          </li>
        </Bullets>

        <Heading>Gana escribiendo</Heading>
        <P>
          Publicar premia. Cuando publicas un capítulo ganas <b>XP</b> y <b>Monedas</b> para tu
          cuenta principal, la misma billetera y rango que construyes en el chat. Los capítulos más
          largos valen un poco más, y escribir varios días en una semana suma un pequeño bono de
          racha.
        </P>
        <Bullets>
          <li>
            La recompensa se paga <b>una vez por capítulo</b>. Despublicar y volver a publicar el
            mismo capítulo no paga otra vez, así que no hay nada que exprimir: solo escribe.
          </li>
          <li>
            Hay un techo diario suave para las ganancias por escritura, para que un solo maratón no
            deje atrás todo lo demás. Repartir capítulos entre varios días gana más que soltarlos
            todos de golpe.
          </li>
        </Bullets>

        <Heading>Vender copias (opcional)</Heading>
        <P>
          La mayoría de las historias se leen gratis. Si quieres, puedes poner una historia detrás
          de <b>Comprar una copia</b>: los lectores reciben una pequeña muestra gratis del primer
          capítulo y luego compran una copia con Monedas para leer el resto. Tú fijas el precio
          (dentro de un rango sensato) o dejas el predeterminado del sitio.
        </P>
        <Bullets>
          <li>
            Comprar una copia es un pago único. Queda ligada a tu cuenta, así que conservas el
            acceso sin importar con qué personaje estés leyendo.
          </li>
          <li>
            El autor gana una <b>regalía</b> en Monedas por cada copia vendida, una forma de que
            los lectores apoyen directamente la escritura que aman.
          </li>
          <li>
            Las historias gratis siguen gratis. La barrera solo aparece en las historias cuyo autor
            decidió usarla, y la tarjeta del catálogo marca cuáles cuestan una copia.
          </li>
        </Bullets>

        <Heading>Tu Biblioteca</Heading>
        <P>
          Cada copia que compras cae en la <b>Biblioteca</b> de tu perfil, un estante con las
          historias que tienes, para que otros vean qué lees y tú puedas volver a cualquiera. Tus
          propias obras publicadas también aparecen ahí. Es el primo de formato largo de fijar
          objetos en tu perfil.
        </P>

        <Tip label="Consejo">
          Los colaboradores (Perfil ▸ Editor de historias ▸ Colaboradores) reciben acceso por rol:
          <b> lector</b> (solo acceso beta), <b>comentarista</b> o <b>coautor</b>. El propietario
          de la historia es implícito y siempre tiene todos los derechos.
        </Tip>
      </>
    ),
  },

  emoticons: {
    title: "Emoticones y reacciones",
    body: (
      <>
        <P>
          The Spire incluye emoticones de hojas de stickers que funcionan de dos maneras: como
          sprites en línea dentro de tus mensajes, y como reacciones al mensaje, MD o publicación
          del foro de alguien más.
        </P>

        <Heading>Emoticones en línea</Heading>
        <P>
          Haz clic en la carita de la barra de formato, encima del cuadro de mensaje. Se abre el
          selector; elige una celda de cualquier hoja y cae donde está tu cursor como un token tipo{" "}
          <K>:happy:0:</K>. Cuando tu mensaje se muestra, el token se convierte en el sprite.
        </P>
        <P>
          Un mensaje que es <i>solo</i> un emoticón (sin más palabras) se muestra a tamaño
          sticker, 84px, en lugar del sprite en línea de 24px. Al estilo Messenger / Discord /
          Telegram.
        </P>

        <Heading>Reacciones</Heading>
        <Bullets>
          <li>
            <b>Dónde</b>, los mensajes de chat, los MD y las publicaciones del foro aceptan
            reacciones.
          </li>
          <li>
            <b>Cómo</b>, el botón <K>+ 😊</K> vive en la fila flotante de herramientas del mensaje,
            al lado derecho (junto a Editar en las líneas de chat, en la barra de acciones en las
            publicaciones del foro). Aparece al pasar el cursor (computadora) o al tocar la fila
            (celular), así las filas del chat no viven llenas de botones.
          </li>
          <li>
            <b>Etiquetas</b>, cada reacción única se agrupa en una etiqueta redonda con el sprite +
            un conteo. Toca una etiqueta para agregar o quitar tu propia reacción.
          </li>
          <li>
            <b>Texto emergente</b>, pasa el cursor por cualquier etiqueta para ver una vista previa
            más grande del sprite y una lista en prosa de quién reaccionó ("Alice y Bob
            reaccionaron con happy", "Alice, Bob y 3 más reaccionaron con happy").
          </li>
          <li>
            <b>Límites</b>, 4 etiquetas visibles en celular, 10 en computadora. Pasado eso, un
            botón <b>+N más</b> abre la lista completa de reacciones agrupada por emoticón.
          </li>
        </Bullets>

        <Heading>Reacciones con emojis Unicode</Heading>
        <P>
          Además de las hojas de stickers, puedes reaccionar con cualquier emoji Unicode estándar.
          Ambos tipos de reacción conviven en el mensaje y se agrupan en etiquetas de la misma
          forma.
        </P>

        <Heading>Hojas de la comunidad y el mercado</Heading>
        <P>
          La biblioteca de stickers es en parte obra de los usuarios. Cualquiera puede enviar una
          hoja para que el equipo de moderación la revise. Una vez aprobada la hoja, cada uso
          gasta <b>una</b> Moneda, que va al artista que la hizo. Los autores pueden activar o
          desactivar el comercio por hoja, así que algunas hojas de la comunidad son gratis. El
          selector muestra el costo por adelantado, así nada es silencioso.
        </P>
        <P>
          Enviar una hoja cuesta una pequeña apuesta de Monedas. Si tu envío se aprueba, la apuesta
          queda gastada y empiezas a ganar cuando la gente la usa; si se rechaza, la apuesta se
          devuelve.
        </P>

        <Tip label="Consejo">
          Los tokens de emoticón (<K>:slug:idx:</K>) no disparan el atajo de acción <K>:</K>{" "}
          (/me), así que un mensaje que empieza con un emoticón se envía como línea de chat normal,
          sin marco de acción en cursivas.
        </Tip>
      </>
    ),
  },

  "rules-page": {
    title: "La página pública de reglas",
    body: (
      <>
        <P>
          The Spire tiene una página pública de reglas que cualquiera puede leer, con o sin
          sesión. Es la declaración oficial de qué es bienvenido aquí y qué no.
        </P>
        <Heading>Cómo abrirla</Heading>
        <Bullets>
          <li>El enlace Reglas en el pie del sitio.</li>
          <li>La etiqueta de atajo <K>{"{rules}"}</K> en cualquier mensaje.</li>
          <li><K>/help</K> abre esta ventana; la página está a un clic más.</li>
        </Bullets>
        <Heading>Qué contiene</Heading>
        <Bullets>
          <li>Las pautas de la comunidad.</li>
          <li>La política de moderación.</li>
          <li>Las reglas de contenido, incluyendo qué está fuera de los límites y cómo funcionan las advertencias de contenido.</li>
          <li>Información de contacto de los moderadores.</li>
        </Bullets>
        <Tip label="Consejo">
          Si una conversación se tuerce y alguien no tiene claro dónde está el límite, enlaza la
          página de reglas en lugar de discutir de memoria. La gracia es tener una sola referencia
          compartida.
        </Tip>
      </>
    ),
  },

  export: {
    title: "Exportar un registro del chat",
    body: (
      <>
        <P>
          ¿Quieres conservar una escena? <K>/export</K> descarga el chat reciente de la sala donde
          estás como una sola página web ordenada (un archivo HTML) que puedes guardar, releer o
          usar para retomar una historia después. Copiar y pegar pierde las horas, los nombres y
          los colores; esto los conserva.
        </P>
        <Heading>Cómo se usa</Heading>
        <Bullets>
          <li><K>/export</K> por sí solo guarda las últimas 12 horas.</li>
          <li>
            Agrega una ventana para ir más atrás: <K>/export 5h</K>, <K>/export 90m</K>, <K>/export 2d</K>.
          </li>
          <li>
            Agrega <K>dark</K> o <K>light</K> para el aspecto de la página: <K>/export 1d light</K>.
            El oscuro es el predeterminado.
          </li>
        </Bullets>
        <Heading>Qué termina en el archivo</Heading>
        <Bullets>
          <li>Cada mensaje de la ventana, en orden, cada uno con su hora.</li>
          <li>
            Quién lo dijo, con el nombre OOC o el nombre del personaje exactamente como aparecía
            entonces, en su color.
          </li>
          <li>
            Tu formato: las negritas, las cursivas, los enlaces y demás se ven como se veían en el
            chat, no como símbolos sueltos.
          </li>
        </Bullets>
        <P>
          El archivo es autónomo, así que se abre en cualquier navegador sin necesidad de internet.
          Guárdalo en una carpeta y tu escena queda a salvo.
        </P>
        <Tip label="Consejo">
          Solo puedes exportar hasta donde se conservan los mensajes aquí. Si pides más que eso, la
          exportación se recorta sin drama a lo que todavía existe y te dice hasta dónde llegó.
        </Tip>
      </>
    ),
  },

  backups: {
    title: "Copias de seguridad portátiles: llévate tu trabajo",
    body: (
      <>
        <P>
          Puedes descargar una copia de tu propio contenido de The Spire en cualquier momento. Las
          copias de seguridad viajan contigo. Si algún día decides irte, te llevas tu trabajo.
        </P>
        <Heading>Qué incluye</Heading>
        <Bullets>
          <li>El perfil y la configuración de tu cuenta principal.</li>
          <li>Cada personaje que has creado, incluyendo sus perfiles, galerías y diarios.</li>
          <li>Las páginas de mundo que has escrito.</li>
          <li>Las historias que has escrito en el Scriptorium.</li>
        </Bullets>
        <Heading>Qué no</Heading>
        <Bullets>
          <li>Los mensajes de otras personas hacia ti, porque son suyos.</li>
          <li>Los objetos, el saldo de Monedas y los rangos. Esos están atados al sistema en vivo.</li>
        </Bullets>
        <Heading>Cómo exportar</Heading>
        <P>
          Abre la sección <b>Cuenta</b> en el panel de Herramientas y elige la opción de exportar.
          Un archivo zip se descarga a tu dispositivo. Guárdalo en un lugar seguro.
        </P>
        <Heading>Qué hay dentro del zip</Heading>
        <P>
          Todo está ordenado en carpetas simples para que sea fácil de encontrar. Cada personaje,
          mundo e historia tiene su propia carpeta, con archivos de texto legibles para el
          contenido y un archivo de datos con los detalles exactos. Las imágenes que subiste se
          guardan directo en las carpetas. Para las imágenes que viven en otra parte de la web,
          como avatares y retratos, recibes un pequeño archivo de enlace en una carpeta{" "}
          <b>Assets</b> que abre el original.
        </P>
        <Tip label="Consejo">
          Las copias de seguridad son una foto del momento. Si sigues escribiendo después de
          exportar, tu perfil en vivo se adelanta al archivo. Vuelve a exportar de vez en cuando si
          quieres mantenerla al día.
        </Tip>
      </>
    ),
  },
};
