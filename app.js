/* ===================================================
   AD USER CREATOR — app.js
   Lida com:
   - Formatação e validação de CPF
   - Geração de e-mail e SamAccountName
   - Geração de script PowerShell (único e em lote)
   - Importação de CSV
   - UX: toast, copy, download, password strength
=================================================== */

/* ---------- Helpers ---------- */

/** Escapa HTML para prevenir XSS */
function escapeHTML(str) {
  if (!str && str !== 0) return '';
  return String(str).replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#039;');
}

/** Escapa aspas simples para prevenir Injeção no PowerShell */
function escapePS(str) {
  if (!str && str !== 0) return '';
  return String(str).replace(/'/g, "''");
}

/** Normaliza string para uso em login/email (remove acentos, espaços, toLowerCase) */
function normalizeStr(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // remove diacríticos
    .replace(/[^a-zA-Z0-9.\-_]/g, '') // mantém apenas caracteres válidos
    .toLowerCase();
}

/**
 * Extrai o primeiro nome, o útimo sobrenome (para login) e todos os sobrenomes (para o AD).
 *
 * Exemplo: "Francisco de Assis Floriano Correa Junior"
 *   first    = "Francisco"
 *   last     = "Junior"         ← usado para gerar Login/Email (primeiro.ultimo)
 *   surnames = "de Assis Floriano Correa Junior"  ← usado como -Surname no AD
 */
function parseFullName(fullName) {
  const particles = new Set(['de','da','do','dos','das','e','di','del','van','von','der','du','le','la','los','las']);
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '', surnames: '' };
  if (parts.length === 1) return { first: parts[0], last: '', surnames: '' };

  // Primeiro nome: primeira palavra (sempre)
  const first = parts[0];

  // Sobrenomes completos: tudo a partir do segundo token
  const surnames = parts.slice(1).join(' ');

  // Último sobrenome não-partícula: usado para compor login/email (primeiro.ultimo)
  let last = '';
  for (let i = parts.length - 1; i >= 1; i--) {
    if (!particles.has(parts[i].toLowerCase())) {
      last = parts[i];
      break;
    }
  }
  if (!last) last = parts[parts.length - 1];

  return { first, last, surnames };
}

/** Remove tudo que não seja dígito do CPF */
function stripCPF(cpf) {
  return cpf.replace(/\D/g, '');
}

/**
 * Normaliza CPF:
 * - Remove pontuação
 * - Preenche com zeros à esquerda até 11 dígitos
 * - Retorna string de 11 dígitos ou null se inválido (>11 dígitos)
 */
function normalizeCPF(raw) {
  const digits = stripCPF(raw);
  if (digits.length > 11) return null;
  return digits.padStart(11, '0');
}

/** Máscara visual do CPF enquanto digita */
function maskCPF(value) {
  const d = value.replace(/\D/g, '').slice(0, 11);
  return d
    .replace(/^(\d{3})/, '$1.')
    .replace(/^(\d{3})\.(\d{3})/, '$1.$2.')
    .replace(/\.(\d{3})\.(\d{3})/, '.$1.$2-')
    .replace(/-(\d{2}).*/, '-$1');
}

/** Valida CPF (algoritmo oficial) */
function validateCPF(cpf11) {
  if (!cpf11 || cpf11.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf11)) return false; // sequência de dígitos iguais
  let sum = 0, rest;
  for (let i = 1; i <= 9; i++) sum += parseInt(cpf11[i - 1]) * (11 - i);
  rest = (sum * 10) % 11;
  if (rest === 10 || rest === 11) rest = 0;
  if (rest !== parseInt(cpf11[9])) return false;
  sum = 0;
  for (let i = 1; i <= 10; i++) sum += parseInt(cpf11[i - 1]) * (12 - i);
  rest = (sum * 10) % 11;
  if (rest === 10 || rest === 11) rest = 0;
  return rest === parseInt(cpf11[10]);
}

/** Avalia força da senha (0-4) */
function passwordStrength(pw) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return Math.min(score, 4);
}

/** Exibe toast de feedback */
function showToast(msg, color = '#10b981') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = color;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

/** Copia texto para área de transferência */
function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => showToast('Copiado! ✓'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Copiado! ✓');
  }
}

/** Faz download de arquivo .ps1 */
function downloadPS1(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

/* ---------- Highlighting ---------- */

/** Aplica um colorização básica ao código PowerShell */
function highlight(code) {
  const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return escaped
    // comentários
    .replace(/(#.+?)(\n|$)/g, '<span class="cmt">$1</span>$2')
    // strings duplas
    .replace(/"([^"]*)"/g, '<span class="str">"$1"</span>')
    // strings simples
    .replace(/'([^']*)'/g, '<span class="str">\'$1\'</span>')
    // variáveis
    .replace(/(\$\w+)/g, '<span class="var">$1</span>')
    // funções/cmdlets comuns
    .replace(/\b(New-ADUser|Set-ADUser|Import-Module|Write-Host|Write-Error|ForEach-Object|ConvertTo-SecureString)\b/g, '<span class="fn">$1</span>')
    // palavras-chave
    .replace(/\b(if|else|foreach|while|try|catch|return|param|function|\-and|\-or|\-not)\b/g, '<span class="kw">$1</span>')
    // parâmetros (traço + Nome)
    .replace(/(-[A-Z][a-zA-Z]+)/g, '<span class="num">$1</span>');
}

/* ---------- Script Generator ---------- */

/**
 * Gera o script PowerShell para criar um usuário no AD.
 * @param {Object} u - Dados do usuário
 */
function generateScript(u) {
  const {
    firstName, lastName, fullName: fullNameRaw, email, sam, cpf11,
    ou, domain, password,
    mustChange, enabled, templateUser,
    surnames,
  } = u;

  // Nome completo digitado (ex: "Francisco de Assis Floriano Correa Junior")
  const displayName = fullNameRaw || `${firstName} ${lastName}`;

  // $LastName = sobrenomes completos; fallback para lastName (última palavra) se não tiver
  const lastNameField = surnames || lastName;

  const dcParts  = domain.split('.').map(p => `DC=${p}`).join(',');
  const ouLine   = ou
    ? `"${ou}"`
    : `"OU=Usuarios,${dcParts}"`;

  const lines = [
    `# ================================================================`,
    `# Script de Criação de Usuário no Active Directory`,
    `# Gerado em: ${new Date().toLocaleString('pt-BR')}`,
    `# Usuário: ${displayName}`,
    ...(templateUser ? [`# Modelo  : ${templateUser}`] : []),
    `# ================================================================`,
    ``,
    `# Importa o módulo do Active Directory`,
    `# -WarningAction SilentlyContinue suprime avisos inofensivos de TypeData (PS 5.1)`,
    `Import-Module ActiveDirectory -ErrorAction Stop -WarningAction SilentlyContinue`,
    `Import-Module Microsoft.PowerShell.Security -ErrorAction SilentlyContinue`,
    ``,
    `# ── Dados do Usuário ────────────────────────────────────────────`,
    `$FirstName    = '${escapePS(firstName)}'`,
    `$LastName     = '${escapePS(lastNameField)}'`,
    `$FullName     = '${escapePS(displayName)}'`,
    `$SamAccount   = '${escapePS(sam)}'`,
    `$UPN          = '${escapePS(email)}'`,
    `$Email        = '${escapePS(email)}'`,
    `$CPF          = '${escapePS(cpf11)}'         # CPF sem pontuação, 11 dígitos`,
    `$OU           = ${ou ? `'${escapePS(ou)}'` : `'OU=Usuarios,${dcParts}'`}`,
    `$Password     = ConvertTo-SecureString '${escapePS(password)}' -AsPlainText -Force`,
    ``,
    `# ── Verificar conflitos antes de criar ──────────────────────────`,
    `$samExiste = Get-ADUser -Filter "SamAccountName -eq '$SamAccount'" -ErrorAction SilentlyContinue`,
    `$upnExiste = Get-ADUser -Filter "UserPrincipalName -eq '$UPN'" -ErrorAction SilentlyContinue`,
    ``,
    `if ($samExiste) {`,
    `    Write-Error "❌ O login '$SamAccount' já existe no AD. Altere o nome ou escolha outro login."`,
    `    exit 1`,
    `}`,
    `if ($upnExiste) {`,
    `    Write-Error "❌ O UPN '$UPN' já existe na floresta. Use um domínio ou sufixo diferente."`,
    `    exit 1`,
    `}`,
    ``,
    `# ── Criar Usuário ───────────────────────────────────────────────`,
    `try {`,
    `    $userParams = @{`,
    `        Name                  = $FullName`,
    `        GivenName             = $FirstName`,
    `        Surname               = $LastName`,
    `        SamAccountName        = $SamAccount`,
    `        UserPrincipalName     = $UPN`,
    `        EmailAddress          = $Email`,
    `        Description           = $CPF`,
    `        Path                  = $OU`,
    `        AccountPassword       = $Password`,
    `        Enabled               = $${enabled ? 'true' : 'false'}`,
    `        ChangePasswordAtLogon = $${mustChange ? 'true' : 'false'}`,
    `    }`,
    `    New-ADUser @userParams`,
    ``,
    `    Write-Host "✅ Usuário '$FullName' criado com sucesso!" -ForegroundColor Green`,
    `    Write-Host "   Login   : $SamAccount"`,
    `    Write-Host "   E-mail  : $Email"`,
    `    Write-Host "   CPF (AD): $CPF"`,
    ``,
    `} catch {`,
    `    Write-Error "❌ Falha ao criar o usuário '$FullName': $_"`,
    `    exit 1`,
    `}`,
  ];

  // ── Bloco de cópia de grupos (se usuário modelo informado) ───────
  if (templateUser && templateUser.trim()) {
    lines.push(
      ``,
      `# ── Copiar Grupos do Usuário Modelo ─────────────────────────────`,
      `# Modelo: ${templateUser}`,
      `$Modelo = '${escapePS(templateUser)}'`,
      ``,
      `try {`,
      `    $Grupos = Get-ADPrincipalGroupMembership -Identity $Modelo |`,
      `                Where-Object { $_.Name -ne 'Domain Users' }`,
      ``,
      `    if ($Grupos.Count -eq 0) {`,
      `        Write-Host "ℹ️  Nenhum grupo adicional encontrado para '$Modelo'." -ForegroundColor Yellow`,
      `    } else {`,
      `        Write-Host "" `,
      `        Write-Host "🔗 Copiando $($Grupos.Count) grupo(s) de '$Modelo'..." -ForegroundColor Cyan`,
      `        foreach ($grupo in $Grupos) {`,
      `            try {`,
      `                Add-ADGroupMember -Identity $grupo.DistinguishedName -Members $SamAccount -ErrorAction Stop`,
      `                Write-Host "   ✅ $($grupo.Name)" -ForegroundColor Green`,
      `            } catch {`,
      `                Write-Warning "   ⚠  Falha no grupo '$($grupo.Name)': $_"`,
      `            }`,
      `        }`,
      `        Write-Host "" `,
      `        Write-Host "✅ Grupos copiados com sucesso!" -ForegroundColor Green`,
      `    }`,
      `} catch {`,
      `    Write-Warning "Não foi possível obter grupos de '$Modelo': $_"`,
      `}`
    );
  }

  return lines.join('\n');
}

/** Gera script em lote a partir de um array de usuários */
function generateBulkScript(users, domain, templateUser) {
  const dcParts = domain.split('.').map(p => `DC=${p}`).join(',');
  const defaultOU = `'OU=Usuarios,${dcParts}'`;

  const header = [
    `# ================================================================`,
    `# Script de Criação de Usuários em LOTE no Active Directory`,
    `# Gerado em: ${new Date().toLocaleString('pt-BR')}`,
    `# Total de usuários: ${users.length}`,
    `# ================================================================`,
    ``,
    `# -WarningAction SilentlyContinue suprime avisos inofensivos de TypeData (PS 5.1)`,
    `Import-Module ActiveDirectory -ErrorAction Stop -WarningAction SilentlyContinue`,
    `Import-Module Microsoft.PowerShell.Security -ErrorAction SilentlyContinue`,
    ``,
    `$usuarios = @(`,
  ];

  const userLines = users.map((u, i) => {
    const comma = i < users.length - 1 ? ',' : '';
    const lastNameField = u.surnames || u.lastName;
    const fullNameField = u.fullName || `${u.firstName} ${lastNameField}`;
    return [
      `    @{`,
      `        FirstName   = '${escapePS(u.firstName)}'`,
      `        LastName    = '${escapePS(lastNameField)}'`,
      `        FullName    = '${escapePS(fullNameField)}'`,
      `        Sam         = '${escapePS(u.sam)}'`,
      `        Email       = '${escapePS(u.email)}'`,
      `        CPF         = '${escapePS(u.cpf11)}'`,
      `        OU          = ${u.ou ? `'${escapePS(u.ou)}'` : defaultOU}`,
      `        Password    = '${escapePS(u.password)}'`,
      `    }${comma}`,
    ].join('\n');
  });

  // Bloco de cópia de grupos para lote (se modelo informado)
  const templateBlock = templateUser && templateUser.trim() ? [
    ``,
    `        # ── Copiar grupos do modelo ──────────────────────────────────`,
    `        try {`,
    `            $Grupos = Get-ADPrincipalGroupMembership -Identity '${escapePS(templateUser)}' |`,
    `                        Where-Object { $_.Name -ne 'Domain Users' }`,
    `            foreach ($grupo in $Grupos) {`,
    `                try { Add-ADGroupMember -Identity $grupo.DistinguishedName -Members $u.Sam -ErrorAction Stop }`,
    `                catch { Write-Warning "Grupo '$($grupo.Name)': $_" }`,
    `            }`,
    `            Write-Host "   🔗 $($Grupos.Count) grupo(s) copiado(s) de '${templateUser}'." -ForegroundColor Cyan`,
    `        } catch {`,
    `            Write-Warning "Grupos de '${templateUser}': $_"`,
    `        }`,
  ] : [];

  const footer = [
    `)`,
    ``,
    `foreach ($u in $usuarios) {`,
    `    # Verificar conflitos antes de criar cada usuário`,
    `    $samExiste = Get-ADUser -Filter "SamAccountName -eq '$($u.Sam)'" -ErrorAction SilentlyContinue`,
    `    $upnExiste = Get-ADUser -Filter "UserPrincipalName -eq '$($u.Email)'" -ErrorAction SilentlyContinue`,
    `    if ($samExiste) { Write-Warning "⚠ Login '$($u.Sam)' já existe — pulando."; continue }`,
    `    if ($upnExiste) { Write-Warning "⚠ UPN '$($u.Email)' já existe na floresta — pulando."; continue }`,
    ``,
    `    try {`,
    `        $SecPw   = ConvertTo-SecureString $u.Password -AsPlainText -Force`,
    `        $OUFINAL = if ($u.OU) { $u.OU } else { ${defaultOU} }`,
    ``,
    `        New-ADUser \``,
    `            -Name              $u.FullName \``,
    `            -GivenName         $u.FirstName \``,
    `            -Surname           $u.LastName \``,
    `            -SamAccountName    $u.Sam \``,
    `            -UserPrincipalName $u.Email \``,
    `            -EmailAddress      $u.Email \``,
    `            -Description       $u.CPF \``,
    `            -Path              $OUFINAL \``,
    `            -AccountPassword   $SecPw \``,
    `            -Enabled           $true \``,
    `            -ChangePasswordAtLogon $true`,
    ``,
    `        Write-Host "✅ $($u.FullName) criado." -ForegroundColor Green`,
    ...templateBlock,
    `    } catch {`,
    `        Write-Error "❌ Falha em $($u.FullName): $_"`,
    `    }`,
    `}`,
  ];

  return [...header, ...userLines, ...footer].join('\n');
}


/* ---------- CPF interaction ---------- */

const cpfInput      = document.getElementById('cpf');
const cpfFormatted  = document.getElementById('cpfFormatted');
const cpfStatus     = document.getElementById('cpfStatus');
const cpfError      = document.getElementById('cpfError');

cpfInput.addEventListener('input', function () {
  this.value = maskCPF(this.value);
  updateCPFPreview(this.value);
});

function updateCPFPreview(raw) {
  const digits = stripCPF(raw);
  if (!digits) {
    cpfFormatted.textContent = '';
    cpfStatus.textContent = '';
    cpfInput.className = '';
    cpfError.textContent = '';
    return;
  }
  const normalized = normalizeCPF(raw);
  if (!normalized) {
    cpfFormatted.textContent = '';
    cpfStatus.textContent = '✗';
    cpfStatus.style.color = 'var(--danger)';
    cpfInput.className = 'is-invalid';
    cpfError.textContent = 'CPF inválido (máx. 11 dígitos).';
    return;
  }
  const isValid = validateCPF(normalized);
  cpfFormatted.textContent = isValid
    ? `Campo Descrição AD: ${normalized}  ← 11 dígitos sem pontuação`
    : `Campo Descrição AD: ${normalized}  (dígitos verificadores incorretos)`;
  cpfStatus.textContent = isValid ? '✓' : '⚠';
  cpfStatus.style.color = isValid ? 'var(--success)' : 'var(--warning)';
  cpfInput.className    = isValid ? 'is-valid' : 'is-invalid';
  cpfError.textContent  = isValid ? '' : 'CPF inválido (verificadores não conferem), mas será aceito.';
}

/* ---------- Name → email / sam ---------- */

const fullNameInput  = document.getElementById('fullName');
const firstNameInput = document.getElementById('firstName');
const lastNameInput  = document.getElementById('lastName');
const emailPreview   = document.getElementById('emailPreview');
const samPreview     = document.getElementById('samPreview');
const domainInput    = document.getElementById('domain');

/**
 * Formata o nome completo: cada palavra começa com maiúscula, exceto as
 * partículas portuguesas (de, da, do, dos, das, e, di, del, van, von, der, …)
 * que ficam em minúscula.
 * A primeira palavra sempre começa com maiúscula independente de ser partícula.
 */
function formatName(value) {
  const particles = new Set([
    'de','da','do','dos','das','e','di','del',
    'van','von','der','du','le','la','los','las',
  ]);

  return value
    .split(' ')
    .map((word, index) => {
      if (!word) return word; // preserva espaços múltiplos enquanto digita
      const lower = word.toLowerCase();
      // Primeira palavra sempre capitalizada; partículas ficam minúsculas
      if (index > 0 && particles.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/** Verifica se um SAM já existe na lista de usuários do AD */
function samExists(sam) {
  if (!window.AD_DATA || !window.AD_DATA.users) return false;
  const s = sam.toLowerCase();
  return window.AD_DATA.users.some(u =>
    (u.samAccountName || '').toLowerCase() === s
  );
}

/**
 * Gera SAMs alternativos quando o primário está em uso.
 * Estratégias (nesta ordem):
 *  1. primeiro.OUTRO_SOBRENOME  — outros sobrenomes não-partícula, do penúltimo para o início
 *  2. primeiro.inicial.ultimo   — iniciaação do sobrenome intermediário
 *  3. primeiro.ultimo2, 3, 4    — sufixo numérico como último recurso
 */
function suggestAlternativeSams(fullName) {
  const particles = new Set([
    'de','da','do','dos','das','e','di','del',
    'van','von','der','du','le','la','los','las',
  ]);
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [];

  const fn = normalizeStr(parts[0]);
  if (!fn) return [];

  // Todos os tokens não-partícula exceto o primeiro nome
  const surnames = parts.slice(1).filter(w => !particles.has(w.toLowerCase()));

  const candidates = [];

  // 1. Cada sobrenome não-partícula como alternativa (exceto o último já usado)
  for (let i = surnames.length - 2; i >= 0; i--) {
    const alt = normalizeStr(surnames[i]);
    if (alt) candidates.push(`${fn}.${alt}`);
  }

  // 2. primeiro.inicial_do_meio.ultimo  (ex: paulo.d.santos)
  const lastSurname = normalizeStr(surnames[surnames.length - 1] || '');
  for (let i = 0; i < surnames.length - 1; i++) {
    const mid = normalizeStr(surnames[i]);
    if (mid && lastSurname) candidates.push(`${fn}.${mid.charAt(0)}.${lastSurname}`);
  }

  // 3. Sufixo numérico
  if (lastSurname) {
    for (let n = 2; n <= 5; n++) candidates.push(`${fn}.${lastSurname}${n}`);
  }

  // Remove duplicatas
  return [...new Set(candidates)].filter(Boolean);
}

function updateEmailAndSam() {
  const fullName = fullNameInput.value.trim();
  const domain   = domainInput.value.trim() || 'orsegups.com.br';
  const { first, last } = parseFullName(fullName);
  const fn = normalizeStr(first);
  const ln = normalizeStr(last);

  // Atualiza campos ocultos usados no gerador de script
  firstNameInput.value = first;
  lastNameInput.value  = last;

  if (fn && ln) {
    emailPreview.value = `${fn}.${ln}@${domain}`;
    samPreview.value   = `${fn}.${ln}`;
  } else if (fn) {
    emailPreview.value = `${fn}@${domain}`;
    samPreview.value   = fn;
  } else {
    emailPreview.value = '';
    samPreview.value   = '';
  }

  // Verifica conflito no AD
  checkSamConflict(fullName, domain);
}

/** Exibe painel de conflito de SAM com sugestões de alternativas */
function checkSamConflict(fullName, domain) {
  const conflictEl  = document.getElementById('samConflict');
  const conflictMsg = document.getElementById('samConflictMsg');
  const altsEl      = document.getElementById('samAlternatives');
  if (!conflictEl) return;

  const currentSam = samPreview.value;
  if (!currentSam || !samExists(currentSam)) {
    conflictEl.style.display = 'none';
    samPreview.classList.remove('is-invalid');
    return;
  }

  // Conflito detectado
  samPreview.classList.add('is-invalid');
  conflictEl.style.display = 'block';

  // Gera alternativas que ainda não estão em uso
  const alts = suggestAlternativeSams(fullName).filter(a => !samExists(a));

  altsEl.innerHTML = '';

  if (!alts.length) {
    conflictMsg.textContent = 'Login já existe no AD — informe um nome diferente.';
    return;
  }

  conflictMsg.textContent = 'Login já existe no AD — clique em uma alternativa:';

  alts.slice(0, 6).forEach(alt => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sam-alt-btn';
    btn.textContent = alt;
    btn.title = `Usar: ${alt}@${domain}`;
    btn.addEventListener('click', () => {
      samPreview.value   = alt;
      emailPreview.value = `${alt}@${domain}`;
      samPreview.classList.remove('is-invalid');
      samPreview.classList.add('is-valid');
      conflictEl.style.display = 'none';
    });
    altsEl.appendChild(btn);
  });
}

fullNameInput.addEventListener('input', function () {
  // Guarda posição do cursor antes de reformatar
  const start = this.selectionStart;
  const end   = this.selectionEnd;
  const prev  = this.value;

  const formatted = formatName(this.value);

  if (formatted !== prev) {
    this.value = formatted;
    // Restaura posição do cursor (pode variar ±0 pois só muda case)
    this.setSelectionRange(start, end);
  }

  updateEmailAndSam();
});

domainInput.addEventListener('input', updateEmailAndSam);


/* ---------- Password strength ---------- */

const passwordInput = document.getElementById('password');
const pwBar         = document.getElementById('pwBar');
const pwHint        = document.getElementById('pwHint');

passwordInput.addEventListener('input', function () {
  const s = passwordStrength(this.value);
  const colors = ['#ef4444', '#f59e0b', '#f59e0b', '#10b981', '#10b981'];
  const labels = ['Muito fraca', 'Fraca', 'Média', 'Forte', 'Muito forte'];
  pwBar.style.width      = `${s * 25}%`;
  pwBar.style.background = colors[s];
  pwHint.textContent     = s ? labels[s] : 'Mínimo 8 caracteres';
  pwHint.style.color     = colors[s];
});

/* ---------- Toggle password visibility ---------- */

const togglePw  = document.getElementById('togglePw');
const eyeOpen   = document.getElementById('eyeOpen');
const eyeClosed = document.getElementById('eyeClosed');

togglePw.addEventListener('click', function () {
  const show = passwordInput.type === 'password';
  passwordInput.type = show ? 'text' : 'password';
  eyeOpen.style.display   = show ? 'none'  : 'block';
  eyeClosed.style.display = show ? 'block' : 'none';
});

/* ---------- Copy buttons (auto) ---------- */

document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.addEventListener('click', function () {
    const target = document.getElementById(this.dataset.target);
    if (target && target.value) copyText(target.value);
  });
});

/* ---------- Form submit → generate script ---------- */

const userForm   = document.getElementById('userForm');
const scriptCode = document.getElementById('scriptCode');
const scriptOut  = document.getElementById('scriptOutput');
const emptyState = document.getElementById('emptyState');
const outputActions = document.getElementById('outputActions');
const summaryEl  = document.getElementById('summary');
const summaryGrid= document.getElementById('summaryGrid');

userForm.addEventListener('submit', function (e) {
  e.preventDefault();

  const fullName  = fullNameInput.value.trim();
  const cpfRaw    = cpfInput.value.trim();
  const password  = passwordInput.value;
  const domain    = domainInput.value.trim() || 'orsegups.com.br';

  let valid = true;

  // Validate Nome Completo
  const fnErr = document.getElementById('fullNameError');
  if (!fullName) {
    fnErr.textContent = 'Obrigatório.'; fullNameInput.className = 'is-invalid'; valid = false;
  } else if (parseFullName(fullName).last === '') {
    fnErr.textContent = 'Informe ao menos nome e sobrenome.'; fullNameInput.className = 'is-invalid'; valid = false;
  } else {
    fnErr.textContent = ''; fullNameInput.className = 'is-valid';
  }

  // Validate CPF
  const cpf11 = normalizeCPF(cpfRaw);
  if (!cpfRaw) {
    cpfError.textContent = 'Obrigatório.'; cpfInput.className = 'is-invalid'; valid = false;
  } else if (!cpf11) {
    cpfError.textContent = 'CPF inválido.'; cpfInput.className = 'is-invalid'; valid = false;
  }

  // Validação de senha removida a pedido do usuário

  if (!valid) return;

  const { first, last, surnames } = parseFullName(fullName);
  const fn    = normalizeStr(first);
  const ln    = normalizeStr(last);

  // Usa o SAM/email que está nos campos de preview — pode ser uma alternativa
  // escolhida pelo usuário. Só recalcula se estiver vazio.
  const sam   = samPreview.value.trim()   || (ln ? `${fn}.${ln}` : fn);
  const email = emailPreview.value.trim() || `${sam}@${domain}`;

  const userData = {
    firstName  : first,
    lastName   : last,
    surnames,
    fullName,
    email, sam, cpf11,
    ou           : document.getElementById('ou').value.trim(),
    domain,
    password,
    mustChange   : document.getElementById('mustChange').checked,
    enabled      : document.getElementById('enabled').checked,
    templateUser : document.getElementById('templateUser').value.trim(),
  };


  const script = generateScript(userData);
  scriptCode.innerHTML = highlight(script);
  scriptOut.style.display  = 'block';
  emptyState.style.display = 'none';
  outputActions.style.display = 'flex';

  // Summary
  summaryGrid.innerHTML = [
    { k: 'Nome Completo',       v: fullName },
    { k: 'Login (SAM)',         v: sam },
    { k: 'E-mail',              v: email },
    { k: 'CPF (Descrição AD)',  v: cpf11 },
    { k: 'OU Selecionada',      v: userData.ou || '— (padrão do domínio)' },
    ...(userData.templateUser ? [{ k: 'Usuário Modelo', v: userData.templateUser }] : []),
  ].map(i => `
    <div class="summary-item">
      <div class="s-key">${i.k}</div>
      <div class="s-val">${i.v}</div>
    </div>
  `).join('');
  // Credenciais
  const credText = `Nome: ${fullName}\nE-mail: ${email}\nSenha: ${password}`;
  const credBox = document.getElementById('credentialsBox');
  const credInput = document.getElementById('credentialsText');
  if (credBox && credInput) {
    credInput.value = credText;
    credBox.style.display = 'block';
    document.getElementById('copyCredentialsBtn')._text = credText;
  }

  summaryEl.style.display = 'block';

  // Salva script para botões copiar/baixar
  document.getElementById('copyScriptBtn')._script  = script;
  document.getElementById('downloadBtn')._script    = script;
  document.getElementById('downloadBtn')._filename  = `criar_${sam}.ps1`;
  document.getElementById('executeBtn')._script     = script;

  showToast('Script gerado com sucesso! ✓');
});

document.getElementById('copyScriptBtn').addEventListener('click', function () {
  if (this._script) copyText(this._script);
});
document.getElementById('copyCredentialsBtn').addEventListener('click', function () {
  if (this._text) copyText(this._text);
});
document.getElementById('downloadBtn').addEventListener('click', function () {
  if (this._script) downloadPS1(this._script, this._filename || 'criar_usuario_ad.ps1');
});

/* ---------- Smart Import (texto livre → CSV) ---------- */

/**
 * Parseia um bloco de texto livre no formato:
 *   Nome: NOME COMPLETO
 *   CPF: 000.000.000-00
 *   (qualquer outro campo é ignorado)
 *   ___ ou linha em branco entre registros
 *
 * Retorna array de { name, cpf } (cpf pode ser '' se ausente no bloco).
 */
function parseSmartImportText(text) {
  const records = [];

  // Divide por separadores (linhas de underscores, hifens, asteriscos, ou múltiplas linhas em branco)
  const blocks = text.split(/(?:_{3,}|-{3,}|\*{3,}|={3,}|\n\s*\n\s*\n)/g);

  blocks.forEach(block => {
    const nameMatch = block.match(/^[ \t]*Nome\s*:\s*(.+)/im);
    const cpfMatch  = block.match(/^[ \t]*CPF\s*:\s*(.+)/im);

    const name = nameMatch ? nameMatch[1].trim() : '';
    const cpf  = cpfMatch  ? cpfMatch[1].trim()  : '';

    // Capitaliza o nome (que pode vir em MAIÚSCULAS)
    const nameFmt = formatName(name);

    if (nameFmt) {
      records.push({ name: nameFmt, cpf });
    }
  });

  return records;
}

/**
 * Gera senha individual: Primeiros 3 dígitos do nome + "@" + 4 dígitos aleatórios.
 */
function generateSmartPassword(firstName) {
  // 4 dígitos criptograficamente aleatórios
  const digits = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map(b => b % 10)
    .join('');

  const prefix = normalizeStr(firstName).substring(0, 3);
  const capitalizedPrefix = prefix.charAt(0).toUpperCase() + prefix.slice(1).toLowerCase();

  return `${capitalizedPrefix}@${digits}`;
}

/* ── Toggle do painel ── */
document.getElementById('smartImportToggle').addEventListener('click', function () {
  const body  = document.getElementById('smartImportBody');
  const caret = document.getElementById('smartImportCaret');
  const open  = body.style.display !== 'none';
  body.style.display  = open ? 'none'  : 'block';
  caret.style.transform = open ? '' : 'rotate(180deg)';
  this.classList.toggle('smart-import-toggle-open', !open);
});

/* ── Converter ── */
document.getElementById('smartImportConvertBtn').addEventListener('click', function () {
  const raw      = document.getElementById('smartImportInput').value.trim();
  const resultEl = document.getElementById('smartImportResult');
  const msgEl    = document.getElementById('smartImportResultMsg');
  const badge    = document.getElementById('smartImportBadge');

  if (!raw) { showToast('Cole o texto antes de converter.', '#f59e0b'); return; }

  const records = parseSmartImportText(raw);
  if (!records.length) {
    showToast('Nenhum "Nome:" encontrado no texto.', '#ef4444');
    return;
  }

  // Monta CSV lines: NomeCompleto,CPF,SenhaIndividual
  const csvLines = records.map(r => {
    const cpfClean = r.cpf.replace(/\D/g, '');
    const { first } = parseFullName(r.name);
    const password  = generateSmartPassword(first);
    return `${r.name},${cpfClean || '00000000000'},${password}`;
  });

  const csvInput = document.getElementById('csvInput');
  // Acrescenta ao CSV existente (ou substitui se estava vazio)
  const existing = csvInput.value.trim();
  csvInput.value = existing ? existing + '\n' + csvLines.join('\n') : csvLines.join('\n');

  // Badge
  badge.textContent = records.length;
  badge.style.display = 'inline-flex';

  // Resultado
  const missing = records.filter(r => !r.cpf).length;
  resultEl.style.display = 'flex';
  resultEl.className = 'smart-import-result smart-import-result-ok';
  msgEl.textContent = `${records.length} usuário(s) convertido(s) — senhas individuais geradas (ex: ${csvLines[0].split(',')[2]})` +
    (missing ? ` — ⚠ ${missing} sem CPF` : '') + '.';

  showToast(`${records.length} registro(s) convertido(s)! ✓`);
});

/* ---------- CSV Bulk — two-phase flow ---------- */

function parseCsvLine(line) {
  return line.split(',').map(s => s.trim());
}

/**
 * Resolve um texto de OU (nome, DN parcial ou DN completo) para o DN exato do AD.
 */
function resolveOuFromInput(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (window.AD_DATA && window.AD_DATA.ous && window.AD_DATA.ous.length) {
    const resolved = resolveOuByName(trimmed);
    if (resolved) return resolved;
  }
  if (trimmed.includes('=')) return trimmed;
  return null;
}

/**
 * Parseia o CSV e detecta conflitos de SAM (no AD e dentro do próprio lote).
 * Retorna array de objetos com campo `conflict` e `alternatives`.
 */
function parseBulkUsers(rawCsv, domain, globalOU) {
  const lines = rawCsv.split('\n').filter(l => l.trim());
  const firstLine = lines[0].toLowerCase();
  const hasHeader = firstLine.includes('nome') || firstLine.includes('first') || firstLine.includes('cpf');
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const ouResolved = resolveOuFromInput(globalOU) || '';

  // Primeiro passe: gera SAMs primários
  const users = dataLines.map(line => {
    const [fullNameCsv = '', cpfRaw = '', password = 'Mudar@2025'] = parseCsvLine(line);
    const { first, last, surnames } = parseFullName(fullNameCsv.trim());
    if (!first || !last) return null;
    const fn    = normalizeStr(first);
    const ln    = normalizeStr(last);
    const cpf11 = normalizeCPF(cpfRaw) || '00000000000';
    const sam   = ln ? `${fn}.${ln}` : fn;
    return { firstName: first, lastName: last, surnames, fullName: fullNameCsv.trim(),
             sam, email: `${sam}@${domain}`, cpf11, ou: ouResolved, password,
             conflict: false, conflictReason: '', alternatives: [] };
  }).filter(Boolean);

  // Rastreia SAMs já usados (AD + linhas anteriores do CSV)
  const usedSams = new Set();

  users.forEach(u => {
    const samLower = u.sam.toLowerCase();
    const inAd  = samExists(u.sam);
    const inCsv = usedSams.has(samLower);

    if (inAd || inCsv) {
      u.conflict = true;
      u.conflictReason = inAd ? 'Já existe no AD' : 'Duplicado no CSV';

      // Gera alternativas livres (nem no AD, nem já usadas no CSV)
      const alts = suggestAlternativeSams(u.fullName)
        .filter(a => !samExists(a) && !usedSams.has(a.toLowerCase()));

      // Tenta auto-resolver com a primeira alternativa disponível
      if (alts.length) {
        u.sam     = alts[0];
        u.email   = `${alts[0]}@${domain}`;
        u.alternatives = alts.slice(1, 6);   // demais para o usuário escolher
        usedSams.add(alts[0].toLowerCase());
      } else {
        u.alternatives = [];
        usedSams.add(samLower); // mantém o original com conflito marcado
        return;
      }
    } else {
      usedSams.add(samLower);
    }
  });

  return users;
}

/* ── Fase 1: Analisar CSV → mostrar tabela de preview ── */
let _bulkParsedUsers = [];

document.getElementById('bulkParseBtn').addEventListener('click', function () {
  const raw = document.getElementById('csvInput').value.trim();
  if (!raw) { showToast('Cole o CSV antes de analisar.', '#f59e0b'); return; }

  const domain   = domainInput.value.trim() || 'orsegups.com.br';
  const globalOU = document.getElementById('bulkOuSelect').value;

  const users = parseBulkUsers(raw, domain, globalOU);
  if (!users.length) { showToast('Nenhum usuário válido encontrado.', '#ef4444'); return; }

  _bulkParsedUsers = users;

  // ── Renderiza tabela de preview ──
  const tbody    = document.getElementById('bulkPreviewBody');
  const statsEl  = document.getElementById('bulkPreviewStats');
  const noteEl   = document.getElementById('bulkPreviewNote');
  tbody.innerHTML = '';

  const conflictCount = users.filter(u => u.conflict).length;

  users.forEach((u, i) => {
    const tr = document.createElement('tr');
    tr.dataset.idx = i;
    if (u.conflict) tr.classList.add('bulk-row-conflict');

    // Coluna #
    const tdNum = document.createElement('td');
    tdNum.textContent = i + 1;
    tr.appendChild(tdNum);

    // Nome completo
    const tdName = document.createElement('td');
    tdName.textContent = u.fullName;
    tr.appendChild(tdName);

    // SAM (editável via alternativas)
    const tdSam = document.createElement('td');
    const samWrap = document.createElement('div');
    samWrap.className = 'bulk-sam-cell';

    const samSpan = document.createElement('span');
    samSpan.className = 'bulk-sam-value' + (u.conflict ? ' bulk-sam-auto' : '');
    samSpan.textContent = u.sam;
    samSpan.id = `bulk-sam-${i}`;
    samWrap.appendChild(samSpan);

    // Botões de alternativas adicionais (caso queira trocar)
    if (u.conflict && u.alternatives.length) {
      const altsWrap = document.createElement('div');
      altsWrap.className = 'bulk-sam-alts';
      u.alternatives.forEach(alt => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sam-alt-btn sam-alt-btn-sm';
        btn.textContent = alt;
        btn.title = `Usar: ${alt}@${domain}`;
        btn.addEventListener('click', () => {
          _bulkParsedUsers[i].sam   = alt;
          _bulkParsedUsers[i].email = `${alt}@${domain}`;
          samSpan.textContent = alt;
          samSpan.className = 'bulk-sam-value bulk-sam-chosen';
          altsWrap.querySelectorAll('.sam-alt-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          tr.classList.remove('bulk-row-conflict');
          tr.classList.add('bulk-row-resolved');
          updatePreviewStats();
        });
        altsWrap.appendChild(btn);
      });
      samWrap.appendChild(altsWrap);
    }

    tdSam.appendChild(samWrap);
    tr.appendChild(tdSam);

    // Email
    const tdEmail = document.createElement('td');
    tdEmail.className = 'bulk-email-cell';
    tdEmail.textContent = u.email;
    tdEmail.id = `bulk-email-${i}`;
    tr.appendChild(tdEmail);

    // Status
    const tdStatus = document.createElement('td');
    if (u.conflict) {
      tdStatus.innerHTML = `<span class="bulk-status-badge bulk-status-conflict">⚡ ${u.conflictReason} — Auto-corrigido</span>`;
    } else {
      tdStatus.innerHTML = `<span class="bulk-status-badge bulk-status-ok">✓ OK</span>`;
    }
    tr.appendChild(tdStatus);

    tbody.appendChild(tr);
  });

  // Stats
  function updatePreviewStats() {
    const remaining = document.querySelectorAll('#bulkPreviewBody tr.bulk-row-conflict').length;
    statsEl.innerHTML = `
      <span class="bulk-stat bulk-stat-total">${users.length} usuário(s)</span>
      ${conflictCount ? `<span class="bulk-stat bulk-stat-warn">⚡ ${conflictCount} conflito(s) detectado(s)</span>` : ''}
      ${remaining ? `<span class="bulk-stat bulk-stat-warn">${remaining} ainda com conflito</span>` : ''}
    `;
    noteEl.textContent = conflictCount
      ? 'Logins conflitantes foram auto-corrigidos. Você pode escolher uma alternativa diferente clicando nos botões abaixo de cada login.'
      : 'Nenhum conflito detectado. Revise os dados e confirme para gerar o script.';
  }
  updatePreviewStats();

  // Mostra a área de preview e colapsa o bulk-left
  document.getElementById('bulkPreviewArea').style.display = 'block';
  document.getElementById('bulkPreviewArea').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  showToast(`${users.length} usuário(s) analisado(s)${conflictCount ? ` — ${conflictCount} conflito(s) auto-corrigido(s)` : ''}! ✓`);
});

/* ── Cancelar preview ── */
document.getElementById('bulkCancelPreviewBtn').addEventListener('click', function () {
  document.getElementById('bulkPreviewArea').style.display = 'none';
  _bulkParsedUsers = [];
});

/* ── Fase 2: Confirmar e Gerar Script ── */
document.getElementById('bulkBtn').addEventListener('click', function () {
  if (!_bulkParsedUsers.length) { showToast('Analise o CSV primeiro.', '#f59e0b'); return; }

  const domain = domainInput.value.trim() || 'orsegups.com.br';
  const unresolved = document.querySelectorAll('#bulkPreviewBody tr.bulk-row-conflict').length;
  if (unresolved) {
    showToast(`⚠ ${unresolved} usuário(s) ainda com conflito não resolvido — revise antes de gerar.`, '#f59e0b');
    return;
  }

  const templateUserBulk = document.getElementById('templateUserBulk').value.trim();
  const script = generateBulkScript(_bulkParsedUsers, domain, templateUserBulk);

  const bulkCode    = document.getElementById('bulkCode');
  const bulkOutput  = document.getElementById('bulkOutput');
  const bulkEmpty   = document.getElementById('bulkEmptyState');
  const bulkActions = document.getElementById('bulkOutputActions');

  bulkCode.innerHTML = highlight(script);
  bulkOutput.style.display  = 'block';
  bulkEmpty.style.display   = 'none';
  bulkActions.style.display = 'flex';

  document.getElementById('copyBulkBtn')._script       = script;
  document.getElementById('downloadBulkBtn')._script   = script;
  document.getElementById('downloadBulkBtn')._filename = 'criar_usuarios_lote.ps1';

  // Credenciais em Lote
  const bulkCredText = _bulkParsedUsers.map(u => 
    `Nome: ${u.fullName}\nE-mail: ${u.email}\nSenha: ${u.password}\n-------------------------`
  ).join('\n');
  const bulkCredBox = document.getElementById('bulkCredentialsBox');
  const bulkCredInput = document.getElementById('bulkCredentialsText');
  if (bulkCredBox && bulkCredInput) {
    bulkCredInput.value = bulkCredText;
    bulkCredBox.style.display = 'block';
    document.getElementById('copyBulkCredentialsBtn')._text = bulkCredText;
  }

  // Oculta preview após gerar
  document.getElementById('bulkPreviewArea').style.display = 'none';

  showToast(`Script gerado para ${_bulkParsedUsers.length} usuário(s)! ✓`);
});

document.getElementById('copyBulkBtn').addEventListener('click', function () {
  if (this._script) copyText(this._script);
});
document.getElementById('copyBulkCredentialsBtn').addEventListener('click', function () {
  if (this._text) copyText(this._text);
});
document.getElementById('downloadBulkBtn').addEventListener('click', function () {
  if (this._script) downloadPS1(this._script, this._filename || 'criar_usuarios_lote.ps1');
});

/* ═══════════════════════════════════════════════════════════════
   OU TREE PICKER
   - Estrutura padrão baseada no domínio informado
   - OUs customizadas salvas em localStorage
   - Expandir / colapsar / pesquisar / selecionar
   - Adicionar e remover OUs manualmente
═══════════════════════════════════════════════════════════════ */

const DEFAULT_OU_TREE = [
  {
    id: 'usuarios', name: 'Usuarios', icon: '👥', children: [
      { id: 'ti',          name: 'TI',             icon: '💻', children: [] },
      { id: 'rh',          name: 'RH',             icon: '👔', children: [] },
      { id: 'financeiro',  name: 'Financeiro',     icon: '💰', children: [] },
      { id: 'comercial',   name: 'Comercial',      icon: '📊', children: [] },
      { id: 'operacional', name: 'Operacional',    icon: '⚙️', children: [] },
      { id: 'diretoria',   name: 'Diretoria',      icon: '🏢', children: [] },
    ]
  },
  {
    id: 'computadores', name: 'Computadores', icon: '🖥️', children: [
      { id: 'servidores',  name: 'Servidores',     icon: '🗄️', children: [] },
      { id: 'estacoes',    name: 'Estacoes',       icon: '💻', children: [] },
    ]
  },
  { id: 'grupos',    name: 'Grupos',           icon: '🗂️', children: [] },
  { id: 'servicos',  name: 'ContasDeServico',  icon: '⚙️', children: [] },
];

const LS_KEY = 'ou_tree_custom';

function getTree() {
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved) return JSON.parse(saved);
  } catch (_) {}
  return JSON.parse(JSON.stringify(DEFAULT_OU_TREE));
}

function saveTree(tree) {
  localStorage.setItem(LS_KEY, JSON.stringify(tree));
}

function buildDN(trail, domain) {
  const d = (domain || domainInput.value.trim() || 'orsegups.com.br');
  const domainSuffix = d.split('.').map(p => `DC=${p}`).join(',');
  const ouParts = [...trail].reverse().map(n => `OU=${n}`);
  return [...ouParts, domainSuffix].join(',');
}

let ouTree       = getTree();
let selectedNode = null;
let pendingNode  = null;
let expandedIds  = new Set(['__root__', 'usuarios']);

const ouModal           = document.getElementById('ouModal');
const openOuPickerBtn   = document.getElementById('openOuPicker');
const closeOuModalBtn   = document.getElementById('closeOuModal');
const cancelOuModalBtn  = document.getElementById('cancelOuModal');
const confirmOuModalBtn = document.getElementById('confirmOuModal');
const adTreeEl          = document.getElementById('adTree');
const treeSearchEl      = document.getElementById('treeSearch');
const detailIconEl      = document.getElementById('detailIcon');
const detailNameEl      = document.getElementById('detailName');
const detailDnEl        = document.getElementById('detailDn');
const selectedPathEl    = document.getElementById('selectedPathPreview');
const addOuParentSel    = document.getElementById('addOuParent');
const addOuNameEl       = document.getElementById('addOuName');
const btnAddOu          = document.getElementById('btnAddOu');
const btnResetTree      = document.getElementById('btnResetTree');
const ouListEl          = document.getElementById('ouList');
const ouHiddenInput     = document.getElementById('ou');
const ouPickerLabel     = document.getElementById('ouPickerLabel');
const ouBreadcrumb      = document.getElementById('ouBreadcrumb');

openOuPickerBtn.addEventListener('click', () => {
  pendingNode = selectedNode;
  ouTree = getTree();
  treeSearchEl.value = '';
  renderTree();
  renderParentSelect();
  renderOuList();
  updateDetailPanel(pendingNode);
  ouModal.style.display = 'flex';
  setTimeout(() => treeSearchEl.focus(), 80);
});

// Usuário que foi clicado na árvore para ser usado como modelo
let _pendingTemplateUser = null;

function closeModal() {
  ouModal.style.display = 'none';
  _pendingTemplateUser = null; // descarta se o modal for fechado sem confirmar
}
closeOuModalBtn.addEventListener('click',  closeModal);
cancelOuModalBtn.addEventListener('click', closeModal);
ouModal.addEventListener('click', e => { if (e.target === ouModal) closeModal(); });

confirmOuModalBtn.addEventListener('click', () => {
  selectedNode = pendingNode;
  applySelection();
  // Se um usuário foi escolhido na árvore como modelo, aplica agora
  if (_pendingTemplateUser && window._applyTemplateUser) {
    window._applyTemplateUser(_pendingTemplateUser);
  }
  _pendingTemplateUser = null;
  closeModal();
});

function applySelection() {
  if (!selectedNode) {
    ouHiddenInput.value = '';
    ouPickerLabel.textContent = 'Clique para escolher a pasta no AD...';
    openOuPickerBtn.classList.remove('has-value');
    ouBreadcrumb.style.display = 'none';
    return;
  }
  ouHiddenInput.value       = selectedNode.dn;
  ouPickerLabel.textContent = selectedNode.dn;
  openOuPickerBtn.classList.add('has-value');

  const domain = domainInput.value.trim() || 'orsegups.com.br';
  const parts  = [domain, ...selectedNode.trail];
  ouBreadcrumb.innerHTML = parts.map((p, i, arr) => {
    const isLast = i === arr.length - 1;
    return `<span class="bc-part">${p}</span>` +
           (isLast ? '' : '<span class="bc-sep"> › </span>');
  }).join('');
  ouBreadcrumb.style.display = 'flex';
}

/* ──── Renderização da árvore ──── */
function renderTree(filter) {
  filter = filter || '';
  adTreeEl.innerHTML = '';
  const domain = domainInput.value.trim() || 'orsegups.com.br';

  // Nó raiz
  const { wrapper: rootWrapper } = createNodeRow({
    id: '__root__', name: domain, icon: '🏛️',
    trail: [], dn: null, isRoot: true,
    hasChildren: ouTree.length > 0, filter
  });
  adTreeEl.appendChild(rootWrapper);

  if (expandedIds.has('__root__')) {
    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'tree-children';
    ouTree.forEach(node => renderNode(node, [], childrenWrap, filter, domain, false));
    adTreeEl.appendChild(childrenWrap);
  }
}

/**
 * @param {boolean} parentMatched - true quando um ancestral já correspondeu ao filtro.
 *   Nesse caso, todos os descendentes devem ser exibidos (o usuário achou a pasta-pai
 *   e quer ver o que há dentro dela).
 */
/**
 * Índice (cache) de usuários agrupados por OU (DN lowercase).
 * Construído uma vez e invalidado quando AD_DATA muda.
 */
let _usersByOuCache = null;
let _usersByOuSource = null; // referência para detectar mudança

function _buildUsersIndex() {
  if (!window.AD_DATA || !Array.isArray(window.AD_DATA.users)) return {};
  // Só constrói se pelo menos um usuário tiver o campo 'ou'
  if (!window.AD_DATA.users.some(u => u.ou)) return {};
  const map = {};
  for (const u of window.AD_DATA.users) {
    if (!u.ou) continue;
    const key = u.ou.toLowerCase();
    if (!map[key]) map[key] = [];
    map[key].push(u);
  }
  return map;
}

/** Retorna os usuários dentro de uma OU (por DN exato). Usa cache interno. */
function getUsersInOU(dn) {
  if (!dn || !window.AD_DATA) return [];
  // Reconstrói o cache se AD_DATA mudou
  if (_usersByOuSource !== window.AD_DATA.users) {
    _usersByOuCache  = _buildUsersIndex();
    _usersByOuSource = window.AD_DATA.users;
  }
  return _usersByOuCache[dn.toLowerCase()] || [];
}

function renderNode(node, parentTrail, container, filter, domain, parentMatched) {
  const trail = [...parentTrail, node.name];
  const dn    = node.exactDn || buildDN(trail, domain);
  const hasOuChildren = !!(node.children && node.children.length);

  // Usuários que pertencem a este nó (só se AD_DATA tiver campo 'ou')
  const usersInOu = getUsersInOU(dn);
  const hasUsers  = usersInOu.length > 0;
  const hasChildren = hasOuChildren || hasUsers;

  const matchesSelf = !filter || node.name.toLowerCase().includes(filter.toLowerCase());
  const childrenHit = hasOuChildren && nodeOrChildMatches(node, filter);

  // Verifica se algum usuário da OU bate no filtro (com precedência explícita)
  let usersHit = false;
  if (hasUsers && filter) {
    const f = filter.toLowerCase();
    usersHit = usersInOu.some(u =>
      (u.displayName    || '').toLowerCase().includes(f) ||
      (u.samAccountName || '').toLowerCase().includes(f) ||
      (u.department     || '').toLowerCase().includes(f)
    );
  }

  // Oculta se: há filtro E nem este nó nem nenhum filho corresponde E o pai não correspondeu
  if (filter && !matchesSelf && !childrenHit && !usersHit && !parentMatched) return;

  // Se este nó corresponde, seus filhos são exibidos independentemente do filtro
  const thisMatched = parentMatched || matchesSelf;

  const { wrapper } = createNodeRow({
    id: node.id, name: node.name, icon: node.icon || '📁',
    trail, dn, isRoot: false, hasChildren, filter,
    hasExactDn: !!node.exactDn,
  });
  container.appendChild(wrapper);

  if (hasChildren && expandedIds.has(node.id)) {
    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'tree-children';

    // Primeiro: sub-OUs
    if (hasOuChildren) {
      node.children.forEach(child =>
        renderNode(child, trail, childrenWrap, filter, domain, thisMatched)
      );
    }

    // Depois: usuários dentro desta OU (só quando há dados com campo 'ou')
    if (hasUsers) {
      const f = filter ? filter.toLowerCase() : '';
      const filtered = filter
        ? usersInOu.filter(u =>
            thisMatched ||
            (u.displayName    || '').toLowerCase().includes(f) ||
            (u.samAccountName || '').toLowerCase().includes(f) ||
            (u.department     || '').toLowerCase().includes(f)
          )
        : usersInOu;

      if (filtered.length) {
        const sep = document.createElement('div');
        sep.className = 'tree-user-separator';
        sep.textContent = `${filtered.length} usuário${filtered.length !== 1 ? 's' : ''}`;
        childrenWrap.appendChild(sep);

        filtered.forEach(u => {
          childrenWrap.appendChild(createUserLeafRow(u, dn, filter));
        });
      }
    }

    wrapper.appendChild(childrenWrap);
  }
}

/**
 * Cria uma linha de usuário dentro da árvore de OUs.
 * Clicar no usuário:
 *   1. Seleciona a OU onde ele está (pendingNode)
 *   2. Marca o usuário como template pendente (_pendingTemplateUser)
 *   3. Atualiza o painel de detalhes
 */
function createUserLeafRow(u, ouDn, filter) {
  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-node-row tree-user-row';

  // Avatar com iniciais
  const avatar = document.createElement('span');
  avatar.className = 'tree-user-avatar';
  const nm = u.displayName || u.samAccountName || '?';
  const parts = nm.trim().split(/\s+/);
  avatar.textContent = parts.length > 1
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : parts[0][0].toUpperCase();

  // Nome + dept
  const info = document.createElement('span');
  info.className = 'tree-user-info';

  const nameEl = document.createElement('span');
  nameEl.className = 'tree-user-name';
  const nameText = u.displayName || u.samAccountName;
  if (filter) {
    const esc = escapeRegex(filter);
    const regex = new RegExp(`(${esc})`, 'gi');
    const parts = nameText.split(regex);
    nameEl.innerHTML = parts.map((part, idx) => 
      idx % 2 === 1 ? `<mark>${escapeHTML(part)}</mark>` : escapeHTML(part)
    ).join('');
  } else {
    nameEl.textContent = nameText;
  }

  const metaEl = document.createElement('span');
  metaEl.className = 'tree-user-meta';
  metaEl.textContent = [
    u.samAccountName,
    u.department || '',
  ].filter(Boolean).join(' · ');

  info.appendChild(nameEl);
  info.appendChild(metaEl);

  // Badge de grupos
  const groupsArray = Array.isArray(u.groups) ? u.groups : (typeof u.groups === 'string' ? [u.groups] : []);
  const groupCount = groupsArray.length;
  const groupBadge = document.createElement('span');
  groupBadge.className = 'tree-user-group-badge';
  groupBadge.textContent = groupCount ? `${groupCount} grupo${groupCount !== 1 ? 's' : ''}` : '—';
  groupBadge.title = groupCount ? `Grupos: ${groupsArray.join(', ')}` : 'Sem grupos de segurança';

  // Indicador: usuário selecionado como modelo pendente
  const isSelected = _pendingTemplateUser && _pendingTemplateUser.samAccountName === u.samAccountName;
  if (isSelected) row.classList.add('tree-user-selected');

  row.appendChild(avatar);
  row.appendChild(info);
  row.appendChild(groupBadge);
  wrapper.appendChild(row);

  row.addEventListener('click', (e) => {
    e.stopPropagation();

    // Seleciona a OU deste usuário como pendingNode
    // Extrai o trail a partir do DN da OU
    const ouParts = ouDn.split(',').filter(p => p.trim().toUpperCase().startsWith('OU=')).map(p => p.trim().slice(3)).reverse();
    pendingNode = { name: ouParts[ouParts.length - 1] || ouDn, trail: ouParts, dn: ouDn };
    updateDetailPanel(pendingNode);

    // Marca o usuário como template pendente
    _pendingTemplateUser = u;

    // Atualiza a seleção visual: remove seleção anterior e re-renderiza
    renderTree(treeSearchEl.value);
  });

  return wrapper;
}

function nodeOrChildMatches(node, filter) {
  if (!filter) return true;
  if (node.name.toLowerCase().includes(filter.toLowerCase())) return true;
  return (node.children || []).some(c => nodeOrChildMatches(c, filter));
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createNodeRow({ id, name, icon, trail, dn, isRoot, hasChildren, filter, hasExactDn }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-node-row';
  if (!isRoot && pendingNode && pendingNode.dn === dn) {
    row.classList.add('selected');
  }

  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle' +
    (hasChildren ? (expandedIds.has(id) ? ' open' : '') : ' empty');
  toggle.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>`;

  const iconEl = document.createElement('span');
  iconEl.className = 'tree-icon';
  const isOpen = expandedIds.has(id);
  iconEl.textContent = (!isRoot && isOpen && icon === '📁') ? '📂' : icon;

  const label = document.createElement('span');
  label.className = 'tree-label' + (isRoot ? ' root-label' : '');
  label.innerHTML = (filter && filter.trim())
    ? name.replace(new RegExp(`(${escapeRegex(filter)})`, 'gi'), '<mark>$1</mark>')
    : name;

  // Indicador visual: ✓ verde = DN exato do AD | ◌ cinza = DN calculado
  if (!isRoot) {
    const dnBadge = document.createElement('span');
    dnBadge.className = hasExactDn ? 'tree-dn-badge tree-dn-exact' : 'tree-dn-badge tree-dn-calc';
    dnBadge.title = hasExactDn
      ? `DN real do AD:\n${dn}`
      : `DN calculado (OU não está na lista do AD):\n${dn}`;
    dnBadge.textContent = hasExactDn ? '✓' : '◌';
    row.appendChild(toggle);
    row.appendChild(iconEl);
    row.appendChild(label);
    row.appendChild(dnBadge);
  } else {
    row.appendChild(toggle);
    row.appendChild(iconEl);
    row.appendChild(label);
  }
  wrapper.appendChild(row);

  if (hasChildren) {
    toggle.addEventListener('click', e => { e.stopPropagation(); toggleExpand(id); });
  }

  row.addEventListener('click', () => {
    if (isRoot) { toggleExpand(id); return; }
    pendingNode = { name, trail, dn };
    updateDetailPanel(pendingNode);
    if (hasChildren) toggleExpand(id);
    else renderTree(treeSearchEl.value);
  });

  return { wrapper, row };
}

function toggleExpand(id) {
  if (expandedIds.has(id)) expandedIds.delete(id);
  else expandedIds.add(id);
  renderTree(treeSearchEl.value);
}

function updateDetailPanel(node) {
  if (!node) {
    detailIconEl.textContent = '📁';
    detailNameEl.textContent = 'Nenhuma pasta selecionada';
    detailDnEl.textContent   = '—';
    selectedPathEl.textContent = 'Nenhuma OU selecionada — será usada a OU padrão do domínio';
    selectedPathEl.classList.remove('active');
    _updateModalUserBanner(null);
    return;
  }
  detailIconEl.textContent = '📂';
  detailNameEl.textContent = node.name;
  detailDnEl.textContent   = node.dn;
  selectedPathEl.textContent = node.dn;
  selectedPathEl.classList.add('active');
  _updateModalUserBanner(_pendingTemplateUser);
}

/** Exibe/oculta o banner de "usuário modelo selecionado" no rodapé do modal */
function _updateModalUserBanner(u) {
  let banner = document.getElementById('_modalUserBanner');
  if (!u) {
    if (banner) banner.style.display = 'none';
    return;
  }
  if (!banner) {
    // Cria o banner na primeira vez e insere antes do selectedPathPreview
    banner = document.createElement('div');
    banner.id = '_modalUserBanner';
    banner.className = 'modal-user-banner';
    const footer = document.getElementById('selectedPathPreview')?.parentElement;
    if (footer) footer.insertBefore(banner, footer.firstChild);
  }
  const groupsArray = Array.isArray(u.groups) ? u.groups : (typeof u.groups === 'string' ? [u.groups] : []);
  const groups = groupsArray.length;
  banner.innerHTML = `
    <div class="modal-user-banner-avatar">${
      (() => {
        const nm = u.displayName || u.samAccountName || '?';
        const p  = nm.trim().split(/\s+/);
        return p.length > 1 ? (p[0][0]+p[p.length-1][0]).toUpperCase() : p[0][0].toUpperCase();
      })()
    }</div>
    <div class="modal-user-banner-info">
      <div class="modal-user-banner-name">${u.displayName || u.samAccountName}</div>
      <div class="modal-user-banner-meta">${u.samAccountName}${u.department ? ' · '+u.department : ''}
        <span class="modal-user-banner-groups">${groups} grupo${groups !== 1 ? 's' : ''} serão copiados</span>
      </div>
    </div>
    <div class="modal-user-banner-label">Modelo</div>`;
  banner.style.display = 'flex';
}

treeSearchEl.addEventListener('input', function () {
  const term = this.value.trim();
  if (term) {
    // Expande TODOS os nós para que o filtro possa mostrar os resultados internos
    expandedIds = new Set(['__root__']);
    expandAll(ouTree);
  } else {
    // Sem filtro: volta ao estado padrão (só raiz e primeiros nós expandidos)
    expandedIds = new Set(['__root__']);
    ouTree.slice(0, 3).forEach(n => expandedIds.add(n.id));
  }
  renderTree(term);
});

function expandAll(nodes) {
  nodes.forEach(n => {
    expandedIds.add(n.id);
    if (n.children && n.children.length) expandAll(n.children);
  });
}

/* ──── Gerenciar OUs ──── */
function renderParentSelect() {
  addOuParentSel.innerHTML = '<option value="__root__">🏛️  Raiz do domínio</option>';
  function addOptions(nodes, depth) {
    nodes.forEach(n => {
      const pad = '\u3000'.repeat(depth);
      const opt = document.createElement('option');
      opt.value = n.id;
      opt.textContent = `${pad}${n.icon || '📁'} ${n.name}`;
      addOuParentSel.appendChild(opt);
      if (n.children && n.children.length) addOptions(n.children, depth + 1);
    });
  }
  addOptions(ouTree, 0);
}

function renderOuList() {
  ouListEl.innerHTML = '';
  function listNodes(nodes, trail) {
    nodes.forEach(n => {
      const t = [...trail, n.name];
      const item = document.createElement('div');
      item.className = 'ou-list-item';
      item.innerHTML = `
        <span class="ou-list-item-icon">${n.icon || '📁'}</span>
        <span class="ou-list-item-name">${n.name}</span>
        <span class="ou-list-item-path">${t.slice(0, -1).join(' › ') || 'Raiz'}</span>
        <button class="btn-del-ou" title="Remover OU">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        </button>`;
      item.querySelector('.btn-del-ou').addEventListener('click', () => {
        if (confirm(`Remover "${n.name}" e suas sub-pastas?`)) {
          removeNode(ouTree, n.id);
          saveTree(ouTree);
          renderTree(treeSearchEl.value);
          renderParentSelect();
          renderOuList();
        }
      });
      ouListEl.appendChild(item);
      if (n.children && n.children.length) listNodes(n.children, t);
    });
  }
  listNodes(ouTree, []);
  if (!ouListEl.children.length) {
    ouListEl.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px 0">Estrutura padrão ativa</div>';
  }
}

function removeNode(nodes, id) {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) { nodes.splice(i, 1); return true; }
    if (nodes[i].children && removeNode(nodes[i].children, id)) return true;
  }
  return false;
}

function findNode(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    const f = findNode(n.children || [], id);
    if (f) return f;
  }
  return null;
}

btnAddOu.addEventListener('click', () => {
  const name = addOuNameEl.value.trim();
  if (!name) { showToast('Informe o nome da OU.', '#f59e0b'); return; }

  const parentId = addOuParentSel.value;
  const newNode  = { id: `ou_${Date.now()}`, name, icon: '📁', children: [] };

  if (parentId === '__root__') {
    ouTree.push(newNode);
  } else {
    const parent = findNode(ouTree, parentId);
    if (!parent) { showToast('Pasta pai não encontrada.', '#ef4444'); return; }
    parent.children.push(newNode);
    expandedIds.add(parentId);
  }

  saveTree(ouTree);
  addOuNameEl.value = '';
  renderTree(treeSearchEl.value);
  renderParentSelect();
  renderOuList();
  showToast(`OU "${name}" adicionada! ✓`);
});

addOuNameEl.addEventListener('keydown', e => { if (e.key === 'Enter') btnAddOu.click(); });

btnResetTree.addEventListener('click', () => {
  if (confirm('Isso apagará todas as OUs personalizadas. Continuar?')) {
    localStorage.removeItem(LS_KEY);
    ouTree = getTree();
    expandedIds = new Set(['__root__', 'usuarios']);
    pendingNode = null;
    updateDetailPanel(null);
    renderTree();
    renderParentSelect();
    renderOuList();
    showToast('Estrutura restaurada ao padrão. ✓');
  }
});

domainInput.addEventListener('input', () => {
  if (ouModal.style.display !== 'none') renderTree(treeSearchEl.value);
  if (selectedNode) {
    selectedNode.dn = buildDN(selectedNode.trail, domainInput.value.trim() || 'orsegups.com.br');
    applySelection();
  }
});

/* ═══════════════════════════════════════════════════════════════
   INTEGRAÇÃO COM AD (via window.AD_DATA gerado por Get-ADData.ps1)
═══════════════════════════════════════════════════════════════ */

/**
 * Constrói a árvore de OUs a partir da lista de DistinguishedNames
 * retornada pelo Get-ADData.ps1.
 *
 * Exemplo de DN: "OU=TI,OU=Usuarios,DC=orsegups,DC=com,DC=br"
 * → caminho: Usuarios > TI
 */
/**
 * Mapa global: DN exato (lowercase) → objeto OU do AD.
 * Populado por buildOUTreeFromAD e usado por resolveOuByName.
 */
const AD_DN_MAP   = {};  // chave = dn.toLowerCase()  → ouObj
const AD_NAME_MAP = {};  // chave = name.toLowerCase() → [ouObj, ...] (pode haver nomes repetidos)

/**
 * Dado um nome de OU (ex: "TI", "São Paulo") ou um DN parcial/completo,
 * tenta resolver para o distinguishedName exato registrado no AD.
 * Retorna o DN exato se encontrado, ou null.
 */
function resolveOuByName(nameOrDn) {
  if (!nameOrDn) return null;
  const trimmed = nameOrDn.trim();

  // 1. Já é um DN completo (contém '=')
  if (trimmed.includes('=')) {
    const key = trimmed.toLowerCase();
    if (AD_DN_MAP[key]) return AD_DN_MAP[key].distinguishedName;
    // Mesmo que não esteja no mapa, retorna como está (confiamos no usuário)
    return trimmed;
  }

  // 2. Busca por nome exato (case-insensitive) — se houver um único resultado
  const key = trimmed.toLowerCase();
  const matches = AD_NAME_MAP[key];
  if (matches && matches.length === 1) return matches[0].distinguishedName;
  if (matches && matches.length > 1) {
    // Retorna o primeiro (menor DN = mais alto na hierarquia)
    return matches.sort((a, b) =>
      a.distinguishedName.length - b.distinguishedName.length
    )[0].distinguishedName;
  }

  // 3. Busca parcial por nome (contém)
  const partial = Object.values(AD_NAME_MAP)
    .flat()
    .filter(o => o.name.toLowerCase().includes(key));
  if (partial.length === 1) return partial[0].distinguishedName;
  if (partial.length > 1) {
    return partial.sort((a, b) =>
      a.distinguishedName.length - b.distinguishedName.length
    )[0].distinguishedName;
  }

  return null; // não encontrado
}

function buildOUTreeFromAD(ous) {
  const root    = [];
  const nodeMap = {};  // chave = caminho completo "Pai>Filho>Neto"

  // Popula os mapas globais de lookup
  for (const ou of ous) {
    AD_DN_MAP[ou.distinguishedName.toLowerCase()] = ou;
    const nameKey = ou.name.toLowerCase();
    if (!AD_NAME_MAP[nameKey]) AD_NAME_MAP[nameKey] = [];
    AD_NAME_MAP[nameKey].push(ou);
  }

  // Ordena por comprimento de DN (menor = mais alto na hierarquia)
  const sorted = [...ous].sort((a, b) =>
    a.distinguishedName.length - b.distinguishedName.length
  );

  for (const ou of sorted) {
    // Extrai somente partes OU= do DN, excluindo DC=
    const ouParts = ou.distinguishedName
      .split(',')
      .filter(p => p.trim().toUpperCase().startsWith('OU='))
      .map(p => p.trim().slice(3));  // remove "OU="

    if (!ouParts.length) continue;

    // DN é escrito de filho para pai; reverter = pai para filho
    const path = [...ouParts].reverse();

    let currentLevel = root;
    let keyAccum     = '';

    for (let i = 0; i < path.length; i++) {
      keyAccum = keyAccum ? `${keyAccum}>${path[i]}` : path[i];
      const isLeaf = i === path.length - 1;

      if (!nodeMap[keyAccum]) {
        const icon = guessOuIcon(path[i]);
        const newNode = {
          id      : 'adou_' + keyAccum.replace(/[^a-z0-9]/gi, '_').toLowerCase(),
          name    : path[i],
          icon,
          children: [],
          // exactDn: DN real do AD, disponível apenas na folha correspondente
          exactDn : isLeaf ? ou.distinguishedName : null,
        };
        nodeMap[keyAccum] = newNode;
        currentLevel.push(newNode);
      } else if (isLeaf && !nodeMap[keyAccum].exactDn) {
        // Se o nó pai já foi criado sem DN (porque era só um caminho intermediário),
        // e agora chegou a OU exata, guardamos o DN real
        nodeMap[keyAccum].exactDn = ou.distinguishedName;
      }
      currentLevel = nodeMap[keyAccum].children;
    }
  }

  return root;
}

/** Escolhe um ícone baseado no nome da OU (heurística simples) */
function guessOuIcon(name) {
  const n = name.toLowerCase();
  if (/^ti$|tecnologia|infra|suporte/.test(n))           return '💻';
  if (/rh|recurso|humano|pessoal/.test(n))               return '👔';
  if (/financeiro|finance|contab|fiscal/.test(n))        return '💰';
  if (/comercial|vendas|sales/.test(n))                  return '📊';
  if (/operacion/.test(n))                               return '⚙️';
  if (/diretor|diretoria|board/.test(n))                 return '🏢';
  if (/usuario|user|people|pessoa/.test(n))              return '👥';
  if (/computad|workstation|desktop|estacao/.test(n))    return '🖥️';
  if (/server|servidor/.test(n))                         return '🗄️';
  if (/grupo|group/.test(n))                             return '🗂️';
  if (/servico|service|conta/.test(n))                   return '⚙️';
  if (/admin|administr/.test(n))                         return '🔐';
  return '📁';
}

/** Ponto de entrada: inicializa a UI com base em window.AD_DATA */
function initWithADData() {
  const pill       = document.getElementById('statusPill');
  const dot        = pill.querySelector('.dot');
  const statusText = document.getElementById('statusText');
  const banner     = document.getElementById('adBanner');
  const bannerWarn = document.getElementById('adBannerWarn');

  if (!window.AD_DATA) {
    // ── Sem dados do AD ─────────────────────────────────────────
    dot.style.background = '#f59e0b';
    statusText.textContent = 'AD não conectado';
    bannerWarn.style.display = 'block';
    return;
  }

  const { domain, currentUser, ous, generatedAt } = window.AD_DATA;

  // ── Status pill ─────────────────────────────────────────────
  dot.style.background = '#10b981';
  statusText.textContent = `AD: ${domain.dnsRoot}`;

  // ── Banner de conexão ────────────────────────────────────────
  const genDate = new Date(generatedAt);
  const genFmt  = genDate.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  document.getElementById('adBannerSub').textContent =
    `Dados exportados em ${genFmt} · ${domain.netBiosName}\\${currentUser.samAccountName}`;
  document.getElementById('adBannerUser').innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> ${domain.netBiosName}\\${currentUser.samAccountName}`;
  document.getElementById('adBannerDomain').innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> ${domain.dnsRoot}`;
  document.getElementById('adBannerOuCount').innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> ${ous.length} OUs`;
  banner.style.display = 'block';

  // ── Pré-preencher campo de domínio ───────────────────────────
  domainInput.value = domain.dnsRoot;
  updateEmailAndSam();  // atualiza preview de e-mail/SAM

  // ── Substituir árvore de OUs pela estrutura real do AD ───────
  if (ous && ous.length > 0) {
    const adTree = buildOUTreeFromAD(ous);
    if (adTree.length > 0) {
      ouTree = adTree;
      // Salva no localStorage para o modal do seletor de OU usar
      saveTree(ouTree);
      // Expande as raízes por padrão
      expandedIds = new Set(['__root__']);
      ouTree.slice(0, 3).forEach(n => expandedIds.add(n.id));
    }

    // ── Seletor de OU com pesquisa para o Lote ───────────────────────────
    (function () {
      const searchEl   = document.getElementById('bulkOuSearch');
      const clearEl    = document.getElementById('bulkOuClear');
      const dropEl     = document.getElementById('bulkOuDropdown');
      const chipEl     = document.getElementById('bulkOuChip');
      const chipName   = document.getElementById('bulkOuChipName');
      const chipDnEl   = document.getElementById('bulkOuChipDn');
      const chipRem    = document.getElementById('bulkOuChipRemove');
      const hiddenEl   = document.getElementById('bulkOuSelect'); // input[type=hidden]

      if (!searchEl) return; // sem AD_DATA ainda

      /** Lista canônica de OUs ordenada: primeiro as mais profundas (mais úteis), depois alfabética */
      const sorted = [...ous].sort((a, b) => {
        const da = a.distinguishedName.split(',').filter(p => p.toUpperCase().startsWith('OU=')).length;
        const db = b.distinguishedName.split(',').filter(p => p.toUpperCase().startsWith('OU=')).length;
        // OUs mais profundas primeiro (subpastas appearão antes das pastas pai)
        if (da !== db) return db - da;
        return a.distinguishedName.localeCompare(b.distinguishedName, 'pt-BR');
      });

      /** Retorna caminho pai→filho ex: ["Usuarios", "TI"] */
      function ouPath(ou) {
        return ou.distinguishedName
          .split(',')
          .filter(p => p.trim().toUpperCase().startsWith('OU='))
          .map(p => p.trim().slice(3))
          .reverse();
      }

      /** Filtra a lista por termo */
      function filter(term) {
        if (!term) return sorted;
        const t = term.toLowerCase();
        return sorted.filter(ou =>
          ou.name.toLowerCase().includes(t) ||
          ou.distinguishedName.toLowerCase().includes(t) ||
          ouPath(ou).join(' ').toLowerCase().includes(t)
        );
      }

      /** Destaca texto */
      function hl(text, term) {
        if (!term) return text;
        const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return text.replace(new RegExp(`(${esc})`, 'gi'), '<mark>$1</mark>');
      }

      /** Renderiza dropdown */
      function renderDrop(results, term) {
        dropEl.innerHTML = '';

        if (!results.length) {
          dropEl.innerHTML = `<div class="bulk-ou-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            Nenhuma OU encontrada para "<strong>${term}</strong>"
          </div>`;
          dropEl.style.display = 'block';
          return;
        }

        // Limita a 80 resultados para performance
        const slice = results.slice(0, 80);
        slice.forEach((ou, idx) => {
          const path     = ouPath(ou);
          const icon     = guessOuIcon(ou.name);
          const leafName = path[path.length - 1] || ou.name;          // última parte = nome da OU
          const parentPath = path.slice(0, -1).join(' › ');            // caminho pai sem a folha

          const item = document.createElement('div');
          item.className = 'bulk-ou-drop-item';
          item.dataset.idx = idx;
          item.innerHTML = `
            <span class="bulk-ou-drop-icon">${icon}</span>
            <div class="bulk-ou-drop-info">
              <div class="bulk-ou-drop-leaf">${hl(leafName, term)}${parentPath ? `<span class="bulk-ou-drop-parent"> › ${hl(parentPath, term)}</span>` : ''}</div>
              <div class="bulk-ou-drop-dn">${hl(ou.distinguishedName, term)}</div>
            </div>`;
          item.addEventListener('mousedown', e => {
            e.preventDefault();
            select(ou);
          });
          dropEl.appendChild(item);
        });

        if (results.length > 80) {
          const more = document.createElement('div');
          more.className = 'bulk-ou-drop-more';
          more.textContent = `+ ${results.length - 80} resultados — refine a busca`;
          dropEl.appendChild(more);
        }

        dropEl.style.display = 'block';
      }

      /** Seleciona uma OU */
      function select(ou) {
        const path = ouPath(ou);
        hiddenEl.value = ou.distinguishedName;
        chipName.textContent = path.join(' › ');
        chipDnEl.textContent = ou.distinguishedName;
        chipEl.querySelector('.bulk-ou-chip-icon').textContent = guessOuIcon(ou.name);
        chipEl.style.display = 'flex';
        searchEl.value = '';
        clearEl.style.display = 'none';
        dropEl.style.display  = 'none';
      }

      /** Limpa seleção */
      function clear() {
        hiddenEl.value = '';
        chipEl.style.display   = 'none';
        searchEl.value         = '';
        clearEl.style.display  = 'none';
        dropEl.style.display   = 'none';
      }

      /* ── Eventos ── */
      let debounce;
      searchEl.addEventListener('input', function () {
        clearEl.style.display = this.value ? 'flex' : 'none';
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          const term = this.value.trim();
          if (!term) { dropEl.style.display = 'none'; return; }
          renderDrop(filter(term), term);
        }, 160);
      });

      searchEl.addEventListener('focus', function () {
        const term = this.value.trim();
        if (term.length >= 1) renderDrop(filter(term), term);
        else if (!hiddenEl.value) renderDrop(sorted.slice(0, 50), ''); // mostra top-50 ao abrir (subpastas primeiro)
      });

      searchEl.addEventListener('blur', () => {
        setTimeout(() => { dropEl.style.display = 'none'; }, 160);
      });

      searchEl.addEventListener('keydown', function (e) {
        const items = dropEl.querySelectorAll('.bulk-ou-drop-item');
        const active = dropEl.querySelector('.bulk-ou-drop-item.focused');
        if (e.key === 'Escape') { dropEl.style.display = 'none'; return; }
        if (!items.length) return;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const next = active ? active.nextElementSibling : items[0];
          active?.classList.remove('focused');
          if (next?.classList.contains('bulk-ou-drop-item')) next.classList.add('focused');
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          const prev = active?.previousElementSibling;
          active?.classList.remove('focused');
          if (prev?.classList.contains('bulk-ou-drop-item')) prev.classList.add('focused');
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (active) {
            const idx = +active.dataset.idx;
            const term = searchEl.value.trim();
            const results = filter(term);
            if (results[idx]) select(results[idx]);
          }
        }
      });

      clearEl.addEventListener('click',    clear);
      chipRem.addEventListener('click',    clear);

    })();
  }
}



// Inicializa ao carregar
initWithADData();

/* ═══════════════════════════════════════════════════════════════
   USUÁRIO MODELO — Autocomplete (reutilizável)
   Busca contra window.AD_DATA.users (exportado pelo Get-ADData.ps1).
   Se AD_DATA não disponível, permite digitar manualmente o SAM.
   Instanciado tanto para o formulário individual quanto para o lote.
═══════════════════════════════════════════════════════════════ */

function initUserSearch({
  searchInputId, dropdownId, hiddenInputId,
  chipId, chipAvatarId, chipNameId, chipSamId,
  clearBtnId, removeBtnId,
  ouInputId,      // (opcional) id do input hidden de OU — para preencher com a OU do modelo
  groupsPanelId,  // (opcional) id do painel onde os grupos do modelo serão exibidos
}) {
  const searchInput = document.getElementById(searchInputId);
  const dropdown    = document.getElementById(dropdownId);
  const hiddenInput = document.getElementById(hiddenInputId);
  const chip        = document.getElementById(chipId);
  const chipAvatar  = document.getElementById(chipAvatarId);
  const chipName    = document.getElementById(chipNameId);
  const chipSam     = document.getElementById(chipSamId);
  const clearBtn    = document.getElementById(clearBtnId);
  const removeBtn   = document.getElementById(removeBtnId);
  const ouInput     = ouInputId     ? document.getElementById(ouInputId)     : null;
  const groupsPanel = groupsPanelId ? document.getElementById(groupsPanelId) : null;

  if (!searchInput) return; // elemento não existe na página

  let debounceTimer = null;

  function getUsers() {
    return (window.AD_DATA && window.AD_DATA.users) ? window.AD_DATA.users : [];
  }

  function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0][0].toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function hlText(text, term) {
    if (!term || !text) return escapeHTML(text);
    const normalize = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const tNorm = normalize(term);
    const txtNorm = normalize(text);
    const idx = txtNorm.indexOf(tNorm);
    if (idx === -1) return escapeHTML(text);
    return escapeHTML(text.substring(0, idx)) + '<mark>' + escapeHTML(text.substring(idx, idx + term.length)) + '</mark>' + escapeHTML(text.substring(idx + term.length));
  }

  function filterUsers(term) {
    const normalize = s => s ? s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() : '';
    const t = normalize(term);
    return getUsers().filter(u =>
      normalize(u.samAccountName).includes(t) ||
      normalize(u.displayName).includes(t)    ||
      normalize(u.name).includes(t)           ||
      normalize(u.department).includes(t)
    ).slice(0, 10);
  }

  function renderDropdown(results, term) {
    dropdown.innerHTML = '';
    if (!results.length) {
      dropdown.innerHTML = `
        <div class="user-dropdown-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          Nenhum usuário encontrado
        </div>`;
      dropdown.style.display = 'block';
      return;
    }
    results.forEach(u => {
      const item = document.createElement('div');
      item.className = 'user-dropdown-item';
      const initials = getInitials(u.displayName || u.samAccountName);
      const groupsArray = Array.isArray(u.groups) ? u.groups : (typeof u.groups === 'string' ? [u.groups] : []);
      const groupCount = groupsArray.length;
      item.innerHTML = `
        <div class="user-dropdown-avatar">${initials}</div>
        <div class="user-dropdown-info">
          <div class="user-dropdown-name">${hlText(u.displayName || u.samAccountName, term)}</div>
          <div class="user-dropdown-meta">
            <span class="user-dropdown-sam">${hlText(u.samAccountName, term)}</span>
            ${u.department ? `<span class="user-dropdown-dept">${u.department}</span>` : ''}
            ${groupCount ? `<span class="user-dropdown-groups-badge">${groupCount} grupo${groupCount !== 1 ? 's' : ''}</span>` : ''}
          </div>
        </div>`;
      item.addEventListener('mousedown', e => { e.preventDefault(); selectUser(u); });
      dropdown.appendChild(item);
    });
    dropdown.style.display = 'block';
  }

  /** Renderiza o painel de grupos do usuário modelo */
  function renderGroupsPanel(u) {
    if (!groupsPanel) return;
    const groups = Array.isArray(u?.groups) ? u.groups : (typeof u?.groups === 'string' ? [u.groups] : []);

    if (!groups.length) {
      groupsPanel.style.display = 'none';
      return;
    }

    groupsPanel.innerHTML = `
      <div class="model-groups-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        Grupos do modelo <strong>${u.displayName || u.samAccountName}</strong>
        <span class="model-groups-count">${groups.length} grupo${groups.length !== 1 ? 's' : ''} serão copiados</span>
      </div>
      <div class="model-groups-list">
        ${groups.map(g => `<span class="model-group-tag">${g}</span>`).join('')}
      </div>`;
    groupsPanel.style.display = 'block';
  }

  function selectUser(u) {
    hiddenInput.value = u.samAccountName;
    const initials = getInitials(u.displayName || u.samAccountName);
    chipAvatar.textContent = initials;
    chipName.textContent   = u.displayName || u.samAccountName;
    chipSam.textContent    = u.samAccountName
      + (u.department ? ` · ${u.department}` : '')
      + (u.title      ? ` · ${u.title}`      : '');
    chip.style.display = 'flex';
    searchInput.value      = '';
    clearBtn.style.display = 'none';
    dropdown.style.display = 'none';

    // ── Preenche a OU automaticamente com a OU do usuário modelo ──
    if (ouInput && u.ou) {
      ouInput.value = u.ou;
      // Atualiza o label do picker de OU para refletir a seleção automática
      const pickerLabel = document.getElementById('ouPickerLabel');
      const breadcrumb  = document.getElementById('ouBreadcrumb');
      const pickerBtn   = document.getElementById('openOuPicker');
      if (pickerLabel) pickerLabel.textContent = u.ou;
      if (pickerBtn)   pickerBtn.classList.add('has-value');
      if (breadcrumb) {
        const domain = document.getElementById('domain')?.value || 'orsegups.com.br';
        // Extrai as partes OU= do DN para mostrar o breadcrumb
        const parts = u.ou.split(',').filter(p => p.trim().toUpperCase().startsWith('OU=')).map(p => p.trim().slice(3)).reverse();
        const allParts = [domain, ...parts];
        breadcrumb.innerHTML = allParts.map((p, i, arr) => {
          const isLast = i === arr.length - 1;
          return `<span class="bc-part">${p}</span>` + (isLast ? '' : '<span class="bc-sep"> › </span>');
        }).join('');
        breadcrumb.style.display = 'flex';
      }
      // Atualiza o nó selecionado internamente para que o modal também saiba
      selectedNode = { name: u.ou.split(',')[0]?.replace(/^OU=/i,'') || u.ou, trail: [], dn: u.ou };
    }

    // ── Exibe os grupos do modelo ──
    renderGroupsPanel(u);
  }

  function clearSelection() {
    hiddenInput.value      = '';
    chip.style.display     = 'none';
    searchInput.value      = '';
    clearBtn.style.display = 'none';
    if (groupsPanel) groupsPanel.style.display = 'none';
  }

  searchInput.addEventListener('input', function () {
    const term = this.value.trim();
    clearBtn.style.display = term ? 'flex' : 'none';
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (term.length < 2) { dropdown.style.display = 'none'; return; }
      const users = getUsers();
      if (!users.length) {
        hiddenInput.value  = term;
        dropdown.innerHTML = `
          <div class="user-dropdown-manual">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            AD não conectado — usando <strong>${term}</strong> como SAM do modelo
          </div>`;
        dropdown.style.display = 'block';
        return;
      }
      renderDropdown(filterUsers(term), term);
    }, 200);
  });

  searchInput.addEventListener('keydown', function (e) {
    const items  = dropdown.querySelectorAll('.user-dropdown-item');
    const active = dropdown.querySelector('.user-dropdown-item.focused');
    if (e.key === 'Escape') { dropdown.style.display = 'none'; return; }
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = active ? active.nextElementSibling : items[0];
      if (active) active.classList.remove('focused');
      if (next && next.classList.contains('user-dropdown-item')) next.classList.add('focused');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = active ? active.previousElementSibling : null;
      if (active) active.classList.remove('focused');
      if (prev && prev.classList.contains('user-dropdown-item')) prev.classList.add('focused');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active) {
        const idx     = [...items].indexOf(active);
        const results = filterUsers(searchInput.value.trim());
        if (results[idx]) selectUser(results[idx]);
      }
    }
  });

  searchInput.addEventListener('blur',  () => setTimeout(() => { dropdown.style.display = 'none'; }, 150));
  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim().length >= 2)
      renderDropdown(filterUsers(searchInput.value.trim()), searchInput.value.trim());
  });

  clearBtn.addEventListener('click', () => {
    searchInput.value      = '';
    clearBtn.style.display = 'none';
    dropdown.style.display = 'none';
    hiddenInput.value      = '';
  });

  removeBtn.addEventListener('click', clearSelection);

  // Retorna a função de seleção para uso externo (ex: seletor de OU na árvore)
  return { selectUser };
}

// ── Instância para o formulário individual ──
const _templateSearchInstance = initUserSearch({
  searchInputId : 'templateUserSearch',
  dropdownId    : 'userDropdown',
  hiddenInputId : 'templateUser',
  chipId        : 'templateChip',
  chipAvatarId  : 'templateChipAvatar',
  chipNameId    : 'templateChipName',
  chipSamId     : 'templateChipSam',
  clearBtnId    : 'clearTemplateUser',
  removeBtnId   : 'removeTemplateUser',
  ouInputId     : 'ou',               // preenche a OU automaticamente
  groupsPanelId : 'templateGroupsPanel', // exibe os grupos do modelo
});
// Exposta globalmente para que a árvore de OUs possa acionar ao clicar num usuário
window._applyTemplateUser = _templateSearchInstance?.selectUser;

// ── Instância para o formulário de lote ──
initUserSearch({
  searchInputId : 'templateUserSearchBulk',
  dropdownId    : 'userDropdownBulk',
  hiddenInputId : 'templateUserBulk',
  chipId        : 'templateChipBulk',
  chipAvatarId  : 'templateChipAvatarBulk',
  chipNameId    : 'templateChipNameBulk',
  chipSamId     : 'templateChipSamBulk',
  clearBtnId    : 'clearTemplateUserBulk',
  removeBtnId   : 'removeTemplateUserBulk',
  groupsPanelId : 'templateGroupsPanelBulk', // exibe grupos no lote também
});

/* ═══════════════════════════════════════════════════════════════
   SERVIDOR LOCAL — Integração com Start-Server.ps1
   Fluxo:
     1. checkServer() → GET /api/ping → recebe token de sessão
     2. executeScript() → POST /api/run com {script: "..."} + token
     3. Terminal exibe a saída linha a linha com colorização
═══════════════════════════════════════════════════════════════ */

(function () {
  const SERVER_PORT = (window.APP_CONFIG && window.APP_CONFIG.serverPort) ? window.APP_CONFIG.serverPort : 7510;
  const SERVER_BASE = `http://localhost:${SERVER_PORT}`;

  let serverToken     = null;
  let serverAvailable = false;

  // Elementos de UI
  const executeBtnEl  = document.getElementById('executeBtn');
  const serverPillEl  = document.getElementById('serverPill');
  const serverPillTxt = document.getElementById('serverPillText');
  const terminalPanel = document.getElementById('terminalPanel');
  const terminalOut   = document.getElementById('terminalOutput');
  const terminalSt    = document.getElementById('terminalStatus');

  /* ── Verifica disponibilidade do servidor ── */
  async function checkServer() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1800);
      const res   = await fetch(`${SERVER_BASE}/api/ping`, { signal: ctrl.signal });
      clearTimeout(timer);

      if (!res.ok) throw new Error();
      const data  = await res.json();
      serverToken     = data.token;
      serverAvailable = true;
      setServerIndicator(true, data.user, data.isAdmin);
    } catch {
      serverToken     = null;
      serverAvailable = false;
      setServerIndicator(false);
    }
  }

  /* ── Atualiza pill do servidor e visibilidade do botão Executar ── */
  function setServerIndicator(online, user, isAdmin) {
    if (serverPillEl) {
      serverPillEl.className = online
        ? 'server-pill server-pill-on'
        : 'server-pill server-pill-off';
    }
    if (serverPillTxt) {
      serverPillTxt.textContent = online
        ? `Servidor${isAdmin ? ' (Admin)' : ''}`
        : 'Servidor offline';
    }
    if (executeBtnEl) {
      executeBtnEl.style.display = online ? 'flex' : 'none';
      executeBtnEl.title = online
        ? `Executar via servidor local (${user || 'localhost'})`
        : 'Servidor offline — execute Start-Server.ps1';
    }
  }

  /* ── Executa o script via servidor local ── */
  async function executeScript(scriptContent) {
    if (!serverAvailable || !serverToken) {
      showToast('Servidor offline. Execute Start-Server.ps1.', '#f59e0b');
      return;
    }

    // Exibe e reseta terminal
    terminalPanel.style.display = 'block';
    terminalOut.innerHTML = '';
    setTerminalStatus('running', '⏳ Executando...');
    appendTermLine('⚡ Enviando script ao servidor local...', 'info');
    terminalPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 315000); // 5min + buffer

      const res = await fetch(`${SERVER_BASE}/api/run`, {
        method : 'POST',
        headers: {
          'Content-Type'   : 'application/json',
          'X-Server-Token' : serverToken,
        },
        body  : JSON.stringify({ script: scriptContent }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (res.status === 401) {
        // Token expirou (servidor reiniciado) — re-obtém e avisa
        await checkServer();
        throw new Error('Token expirou (servidor foi reiniciado). Tente novamente.');
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Erro HTTP ${res.status}`);
      }

      const data = await res.json();

      // Anima linhas uma a uma
      terminalOut.innerHTML = '';
      for (const line of (data.lines || [])) {
        appendTermLine(line);
        await new Promise(r => setTimeout(r, 20));
      }

      if (data.success) {
        setTerminalStatus('success', '✅ Concluído com sucesso');
        showToast('Usuário criado com sucesso! ✓');
      } else {
        setTerminalStatus('error', `❌ Falhou (código ${data.exitCode})`);
        showToast('Falhou — veja o terminal.', '#ef4444');
      }

    } catch (err) {
      terminalOut.innerHTML = '';
      appendTermLine(`❌ ${err.message}`, 'error');
      setTerminalStatus('error', 'Erro de comunicação');
      showToast('Erro ao comunicar com o servidor.', '#ef4444');
    }
  }

  /* ── Atualiza badge de status do terminal ── */
  function setTerminalStatus(type, text) {
    if (!terminalSt) return;
    terminalSt.textContent = text;
    terminalSt.className = `terminal-status-badge terminal-st-${type}`;
  }

  /* ── Adiciona linha ao terminal com colorização automática ── */
  function appendTermLine(text, typeHint) {
    const line  = document.createElement('div');
    line.className = 'tline';
    const lower = (text || '').toLowerCase();

    if (typeHint === 'error'
        || text.includes('❌') || text.startsWith('⚠  STDERR')
        || lower.includes('falha') || lower.includes('error') || lower.includes('erro')
        || lower.includes('exception')) {
      line.classList.add('tl-error');
    } else if (text.includes('✅') || lower.includes('sucesso') || lower.includes('criado')
               || lower.includes('copiado') || /\bok\b/.test(lower)) {
      line.classList.add('tl-success');
    } else if (text.includes('⚠') || text.includes('Warning') || lower.includes('aviso')
               || lower.includes('warning') || lower.includes('pulando')) {
      line.classList.add('tl-warn');
    } else if (text.includes('🔗') || text.includes('⚡') || text.includes('ℹ')
               || typeHint === 'info' || lower.includes('copiando') || lower.includes('grupos')) {
      line.classList.add('tl-info');
    } else if (text.startsWith('#') || text.startsWith('//')) {
      line.classList.add('tl-comment');
    }

    line.textContent = text || '\u00a0'; // non-breaking space for empty lines
    terminalOut.appendChild(line);
    terminalOut.scrollTop = terminalOut.scrollHeight;
  }

  /* ── Event listeners ── */
  if (executeBtnEl) {
    executeBtnEl.addEventListener('click', () => {
      const script = executeBtnEl._script;
      if (!script) { showToast('Gere o script primeiro.', '#f59e0b'); return; }
      executeScript(script);
    });
  }

  document.getElementById('terminalClearBtn')?.addEventListener('click', () => {
    terminalOut.innerHTML = '';
    terminalPanel.style.display = 'none';
  });

  /* ── Inicialização ── */
  checkServer();
  setInterval(checkServer, 15000); // re-verifica a cada 15s
})();

/* ═══════════════════════════════════════════════════════════════
   TAB SWITCHING
   Controla a visibilidade dos painéis: Criar / Desabilitar / Bloqueados
═══════════════════════════════════════════════════════════════ */
(function () {
  const tabCreate  = document.getElementById('tabBtnCreate');
  const tabDisable = document.getElementById('tabBtnDisable');
  const tabLocked  = document.getElementById('tabBtnLocked');
  const mainPanel  = document.querySelector('main.container');
  const disPanel   = document.getElementById('panelDisable');
  const lockPanel  = document.getElementById('panelLocked');

  const allTabs   = [tabCreate, tabDisable, tabLocked].filter(Boolean);
  const allPanels = [mainPanel, disPanel, lockPanel].filter(Boolean);

  function showTab(name) {
    allTabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    allPanels.forEach(p => { p.style.display = 'none'; });

    if (name === 'create') {
      tabCreate.classList.add('active'); tabCreate.setAttribute('aria-selected', 'true');
      if (mainPanel) mainPanel.style.display = '';
    } else if (name === 'disable') {
      tabDisable.classList.add('active'); tabDisable.setAttribute('aria-selected', 'true');
      if (disPanel) disPanel.style.display = '';
    } else if (name === 'locked') {
      if (tabLocked) { tabLocked.classList.add('active'); tabLocked.setAttribute('aria-selected', 'true'); }
      if (lockPanel) lockPanel.style.display = '';
      if (window._lockedMonitorCheckNow) window._lockedMonitorCheckNow();
    }
  }

  tabCreate.addEventListener('click',  () => showTab('create'));
  tabDisable.addEventListener('click', () => showTab('disable'));
  if (tabLocked) tabLocked.addEventListener('click', () => showTab('locked'));
})();


/* ═══════════════════════════════════════════════════════════════
   DESABILITAR USUÁRIO — Gerador de Script PowerShell
═══════════════════════════════════════════════════════════════ */

/**
 * Gera script PowerShell para desabilitar uma conta no AD.
 * @param {Object} opts
 */
function generateDisableScript({ sam, displayName, reason, moveOu, targetOu, expirePassword }) {
  const timestamp = new Date().toLocaleString('pt-BR');
  const reasonLine = reason ? `# Motivo  : ${reason}` : '';

  const lines = [
    `# ================================================================`,
    `# Script de Desabilitação de Usuário no Active Directory`,
    `# Gerado em: ${timestamp}`,
    `# Usuário: ${displayName || sam}`,
    ...(reasonLine ? [reasonLine] : []),
    `# ================================================================`,
    ``,
    `Import-Module ActiveDirectory -ErrorAction Stop`,
    ``,
    `# ── Dados do Usuário ────────────────────────────────────────────`,
    `$SamAccount = "${sam}"`,
    ...(reason ? [`$Motivo    = "${reason}"`] : []),
    ``,
    `# ── Desabilitar conta ───────────────────────────────────────────`,
    `try {`,
    `    $User = Get-ADUser -Identity $SamAccount -ErrorAction Stop`,
    ``,
    `    # Desabilita a conta`,
    `    Disable-ADAccount -Identity $SamAccount -ErrorAction Stop`,
    `    Write-Host "✅ Conta '$SamAccount' desabilitada com sucesso!" -ForegroundColor Green`,
  ];

  if (expirePassword) {
    lines.push(
      ``,
      `    # Expira a senha imediatamente`,
      `    Set-ADUser -Identity $SamAccount -PasswordNeverExpires $false -ErrorAction SilentlyContinue`,
      `    Set-ADUser -Identity $SamAccount -ChangePasswordAtLogon $true -ErrorAction SilentlyContinue`,
      `    Write-Host "   🔑 Senha expirada — usuário deverá redefinir ao próximo login." -ForegroundColor Cyan`,
    );
  }

  if (moveOu && targetOu) {
    lines.push(
      ``,
      `    # Move para OU de desabilitados`,
      `    $TargetOU = "${targetOu}"`,
      `    Move-ADObject -Identity $User.DistinguishedName -TargetPath $TargetOU -ErrorAction Stop`,
      `    Write-Host "   📂 Conta movida para: $TargetOU" -ForegroundColor Cyan`,
    );
  }

  if (reason) {
    lines.push(
      ``,
      `    # Registra motivo na descrição da conta`,
      `    $DataHoje = (Get-Date).ToString("dd/MM/yyyy")`,
      `    Set-ADUser -Identity $SamAccount -Description "DESABILITADO em $DataHoje - $Motivo" -ErrorAction SilentlyContinue`,
      `    Write-Host "   📝 Motivo registrado na descrição da conta." -ForegroundColor Cyan`,
    );
  }

  lines.push(
    ``,
    `    Write-Host ""`,
    `    Write-Host "✅ Operação concluída!" -ForegroundColor Green`,
    ``,
    `} catch {`,
    `    Write-Error "❌ Falha ao desabilitar '$SamAccount': $_"`,
    `    exit 1`,
    `}`,
  );

  return lines.join('\n');
}

/* ═══════════════════════════════════════════════════════════════
   DESABILITAR USUÁRIO — Autocomplete de busca
═══════════════════════════════════════════════════════════════ */
(function () {
  const searchEl   = document.getElementById('disableUserSearch');
  const clearEl    = document.getElementById('clearDisableUser');
  const dropEl     = document.getElementById('disableUserDropdown');
  const chipEl     = document.getElementById('disableUserChip');
  const avatarEl   = document.getElementById('disableChipAvatar');
  const nameEl     = document.getElementById('disableChipName');
  const metaEl     = document.getElementById('disableChipMeta');
  const statusEl   = document.getElementById('disableChipStatus');
  const removeEl   = document.getElementById('removeDisableUser');
  const hiddenEl   = document.getElementById('disableUserSam');
  const genBtn     = document.getElementById('generateDisableBtn');

  if (!searchEl) return;

  let debounceTimer = null;
  let selectedUser  = null;

  function getUsers() {
    return (window.AD_DATA && window.AD_DATA.users) ? window.AD_DATA.users : [];
  }

  function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0][0].toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function hlText(text, term) {
    if (!term || !text) return text;
    const normalize = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const tNorm = normalize(term);
    const txtNorm = normalize(text);
    const idx = txtNorm.indexOf(tNorm);
    if (idx === -1) return text;
    return text.substring(0, idx) + '<mark>' + text.substring(idx, idx + term.length) + '</mark>' + text.substring(idx + term.length);
  }

  function filterUsers(term) {
    const normalize = s => s ? s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() : '';
    const t = normalize(term);
    return getUsers().filter(u =>
      normalize(u.samAccountName).includes(t) ||
      normalize(u.displayName).includes(t)    ||
      normalize(u.name).includes(t)           ||
      normalize(u.department).includes(t)
    ).slice(0, 12);
  }

  function renderDrop(results, term) {
    dropEl.innerHTML = '';
    if (!results.length) {
      dropEl.innerHTML = `
        <div class="user-dropdown-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          Nenhum usuário encontrado
        </div>`;
      dropEl.style.display = 'block';
      return;
    }
    results.forEach(u => {
      const item = document.createElement('div');
      item.className = 'user-dropdown-item';
      const initials = getInitials(u.displayName || u.samAccountName);
      const isDisabled = u.enabled === false;
      item.innerHTML = `
        <div class="user-dropdown-avatar" style="${isDisabled ? 'background:linear-gradient(135deg,#6b7280,#9ca3af)' : ''}">${initials}</div>
        <div class="user-dropdown-info">
          <div class="user-dropdown-name">${hlText(u.displayName || u.samAccountName, term)}
            ${isDisabled ? '<span style="font-size:10px;background:#ef444420;color:#ef4444;border:1px solid #ef444430;border-radius:99px;padding:1px 7px;margin-left:6px;">Já desabilitado</span>' : ''}
          </div>
          <div class="user-dropdown-meta">
            <span class="user-dropdown-sam">${hlText(u.samAccountName, term)}</span>
            ${u.department ? `<span class="user-dropdown-dept">${u.department}</span>` : ''}
            ${u.title ? `<span class="user-dropdown-dept">${u.title}</span>` : ''}
          </div>
        </div>`;
      item.addEventListener('mousedown', e => { e.preventDefault(); selectUser(u); });
      dropEl.appendChild(item);
    });
    dropEl.style.display = 'block';
  }

  function selectUser(u) {
    selectedUser = u;
    hiddenEl.value = u.samAccountName;

    const initials = getInitials(u.displayName || u.samAccountName);
    avatarEl.textContent = initials;
    nameEl.textContent   = u.displayName || u.samAccountName;
    metaEl.textContent   = u.samAccountName
      + (u.department ? ` · ${u.department}` : '')
      + (u.title ? ` · ${u.title}` : '');

    const isDisabled = u.enabled === false;
    statusEl.textContent  = isDisabled ? '● Já desabilitado' : '● Conta ativa';
    statusEl.className    = 'disable-chip-status ' +
      (isDisabled ? 'disable-status-disabled' : 'disable-status-enabled');

    chipEl.style.display   = 'flex';
    searchEl.value         = '';
    clearEl.style.display  = 'none';
    dropEl.style.display   = 'none';

    // Habilita o botão de gerar script
    genBtn.disabled = false;
  }

  function clearSelection() {
    selectedUser         = null;
    hiddenEl.value       = '';
    chipEl.style.display = 'none';
    searchEl.value       = '';
    clearEl.style.display = 'none';
    genBtn.disabled      = true;
  }

  searchEl.addEventListener('input', function () {
    const term = this.value.trim();
    clearEl.style.display = term ? 'flex' : 'none';
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (term.length < 2) { dropEl.style.display = 'none'; return; }
      const users = getUsers();
      if (!users.length) {
        // Sem AD_DATA: permite digitar o SAM manualmente
        hiddenEl.value = term;
        dropEl.innerHTML = `
          <div class="user-dropdown-manual">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            AD não conectado — usando <strong>${term}</strong> como SAM
          </div>`;
        dropEl.style.display = 'block';
        genBtn.disabled = false;
        return;
      }
      renderDrop(filterUsers(term), term);
    }, 200);
  });

  searchEl.addEventListener('focus', function () {
    const term = this.value.trim();
    if (term.length >= 2) renderDrop(filterUsers(term), term);
  });

  searchEl.addEventListener('blur', () => setTimeout(() => { dropEl.style.display = 'none'; }, 150));

  searchEl.addEventListener('keydown', function (e) {
    const items  = dropEl.querySelectorAll('.user-dropdown-item');
    const active = dropEl.querySelector('.user-dropdown-item.focused');
    if (e.key === 'Escape') { dropEl.style.display = 'none'; return; }
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = active ? active.nextElementSibling : items[0];
      active?.classList.remove('focused');
      if (next?.classList.contains('user-dropdown-item')) next.classList.add('focused');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = active?.previousElementSibling;
      active?.classList.remove('focused');
      if (prev?.classList.contains('user-dropdown-item')) prev.classList.add('focused');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active) {
        const idx = [...items].indexOf(active);
        const term = searchEl.value.trim();
        const results = filterUsers(term);
        if (results[idx]) selectUser(results[idx]);
      }
    }
  });

  clearEl.addEventListener('click', () => {
    searchEl.value = '';
    clearEl.style.display = 'none';
    dropEl.style.display  = 'none';
    hiddenEl.value = '';
  });
  removeEl.addEventListener('click', clearSelection);

  /* ── Toggle da linha de OU de destino ── */
  document.getElementById('disableMoveOu').addEventListener('change', function () {
    document.getElementById('disableOuRow').style.display = this.checked ? 'block' : 'none';
  });

  /* ── Gerar Script ── */
  document.getElementById('generateDisableBtn').addEventListener('click', function () {
    const sam = hiddenEl.value.trim();
    if (!sam) { showToast('Selecione um usuário primeiro.', '#f59e0b'); return; }

    const displayName    = selectedUser ? (selectedUser.displayName || sam) : sam;
    const reason         = document.getElementById('disableReason').value.trim();
    const moveOu         = document.getElementById('disableMoveOu').checked;
    const targetOu       = document.getElementById('disableOuSelect').value.trim();
    const expirePassword = document.getElementById('disableExpirePassword').checked;

    const script = generateDisableScript({ sam, displayName, reason, moveOu, targetOu, expirePassword });

    const scriptCodeEl = document.getElementById('disableScriptCode');
    const scriptOutEl  = document.getElementById('disableScriptOutput');
    const emptyEl      = document.getElementById('disableEmptyState');
    const actionsEl    = document.getElementById('disableOutputActions');
    const summaryEl    = document.getElementById('disableSummary');
    const summaryGrid  = document.getElementById('disableSummaryGrid');

    scriptCodeEl.innerHTML = highlight(script);
    scriptOutEl.style.display  = 'block';
    emptyEl.style.display      = 'none';
    actionsEl.style.display    = 'flex';

    // Summary
    summaryGrid.innerHTML = [
      { k: 'Usuário (SAM)',    v: sam },
      { k: 'Nome Completo',   v: displayName },
      { k: 'Expirar Senha',   v: expirePassword ? 'Sim' : 'Não' },
      { k: 'Mover para OU',   v: (moveOu && targetOu) ? targetOu : 'Não' },
      ...(reason ? [{ k: 'Motivo', v: reason }] : []),
    ].map(i => `
      <div class="summary-item">
        <div class="s-key">${i.k}</div>
        <div class="s-val">${i.v}</div>
      </div>
    `).join('');
    summaryEl.style.display = 'block';

    // Armazena script para os botões
    document.getElementById('copyDisableScriptBtn')._script = script;
    document.getElementById('downloadDisableBtn')._script   = script;
    document.getElementById('downloadDisableBtn')._filename = `desabilitar_${sam}.ps1`;
    document.getElementById('executeDisableBtn')._script    = script;

    showToast('Script de desabilitação gerado! ✓');
  });

  document.getElementById('copyDisableScriptBtn').addEventListener('click', function () {
    if (this._script) copyText(this._script);
  });
  document.getElementById('downloadDisableBtn').addEventListener('click', function () {
    if (this._script) downloadPS1(this._script, this._filename || 'desabilitar_usuario.ps1');
  });

})();


/* ═══════════════════════════════════════════════════════════════
   SERVIDOR LOCAL — Integração com a aba Desabilitar
   Reutiliza o mesmo servidor Start-Server.ps1
═══════════════════════════════════════════════════════════════ */
(function () {
  const SERVER_PORT = (window.APP_CONFIG && window.APP_CONFIG.serverPort) ? window.APP_CONFIG.serverPort : 7510;
  const SERVER_BASE = `http://localhost:${SERVER_PORT}`;

  const execBtn       = document.getElementById('executeDisableBtn');
  const terminalPanel = document.getElementById('disableTerminalPanel');
  const terminalOut   = document.getElementById('disableTerminalOutput');
  const terminalSt    = document.getElementById('disableTerminalStatus');

  // Verifica servidor e mostra/oculta botão Executar (compartilhado com o ping da aba principal)
  async function checkAndToggle() {
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1800);
      const res   = await fetch(`${SERVER_BASE}/api/ping`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (execBtn) {
        execBtn.style.display = 'flex';
        execBtn.title = `Executar via servidor local (${data.user || 'localhost'})`;
      }
      return data.token;
    } catch {
      if (execBtn) execBtn.style.display = 'none';
      return null;
    }
  }

  function setStatus(type, text) {
    if (!terminalSt) return;
    terminalSt.textContent = text;
    terminalSt.className = `terminal-status-badge terminal-st-${type}`;
  }

  function addLine(text, hint) {
    const div = document.createElement('div');
    div.className = 'tline';
    const lower = (text || '').toLowerCase();
    if (hint === 'error' || text.includes('❌') || lower.includes('falha') || lower.includes('error'))
      div.classList.add('tl-error');
    else if (text.includes('✅') || lower.includes('sucesso') || lower.includes('desabilitado'))
      div.classList.add('tl-success');
    else if (text.includes('⚠') || lower.includes('warning'))
      div.classList.add('tl-warn');
    else if (text.includes('🔑') || text.includes('📂') || text.includes('📝') || hint === 'info')
      div.classList.add('tl-info');
    div.textContent = text || '\u00a0';
    terminalOut.appendChild(div);
    terminalOut.scrollTop = terminalOut.scrollHeight;
  }

  if (execBtn) {
    execBtn.addEventListener('click', async () => {
      const script = execBtn._script;
      if (!script) { showToast('Gere o script primeiro.', '#f59e0b'); return; }

      const token = await checkAndToggle();
      if (!token) { showToast('Servidor offline. Execute Start-Server.ps1.', '#f59e0b'); return; }

      terminalPanel.style.display = 'block';
      terminalOut.innerHTML = '';
      setStatus('running', '⏳ Executando...');
      addLine('⚡ Enviando script ao servidor local...', 'info');
      terminalPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      try {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 315000);
        const res = await fetch(`${SERVER_BASE}/api/run`, {
          method : 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Server-Token': token },
          body   : JSON.stringify({ script }),
          signal : ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Erro HTTP ${res.status}`);
        }
        const data = await res.json();
        terminalOut.innerHTML = '';
        for (const line of (data.lines || [])) {
          addLine(line);
          await new Promise(r => setTimeout(r, 20));
        }
        if (data.success) {
          setStatus('success', '✅ Concluído');
          showToast('Conta desabilitada com sucesso! ✓');
        } else {
          setStatus('error', `❌ Falhou (código ${data.exitCode})`);
          showToast('Falhou — veja o terminal.', '#ef4444');
        }
      } catch (err) {
        addLine(`❌ ${err.message}`, 'error');
        setStatus('error', 'Erro de comunicação');
        showToast('Erro ao comunicar com o servidor.', '#ef4444');
      }
    });
  }

  document.getElementById('disableTerminalClearBtn')?.addEventListener('click', () => {
    terminalOut.innerHTML = '';
    terminalPanel.style.display = 'none';
  });

  // Sincroniza estado do botão Executar com o ping periódico do servidor principal
  checkAndToggle();
  setInterval(checkAndToggle, 15000);
})();


/* ═══════════════════════════════════════════════════════════════
   DESABILITAR — SUB-ABAS (Individual / Em Lote)
═══════════════════════════════════════════════════════════════ */
(function () {
  const btnSingle = document.getElementById('disSubBtnSingle');
  const btnBulk   = document.getElementById('disSubBtnBulk');
  const panelSingle = document.getElementById('disSubPanelSingle');
  const panelBulk   = document.getElementById('disSubPanelBulk');

  if (!btnSingle || !btnBulk) return;

  function showSub(name) {
    if (name === 'single') {
      btnSingle.classList.add('active');
      btnBulk.classList.remove('active');
      panelSingle.style.display = '';
      panelBulk.style.display   = 'none';
    } else {
      btnBulk.classList.add('active');
      btnSingle.classList.remove('active');
      panelBulk.style.display   = '';
      panelSingle.style.display = 'none';
    }
  }

  btnSingle.addEventListener('click', () => showSub('single'));
  btnBulk.addEventListener('click',   () => showSub('bulk'));
})();


/* ═══════════════════════════════════════════════════════════════
   DESABILITAR EM LOTE — Script Generator
═══════════════════════════════════════════════════════════════ */

/**
 * Gera script PowerShell para desabilitar múltiplas contas em lote.
 * @param {Array}  users         - [{sam, displayName}, ...]
 * @param {string} reason        - motivo global (opcional)
 * @param {boolean} moveOu       - mover para OU de desabilitados
 * @param {string} targetOu      - OU de destino (se moveOu=true)
 * @param {boolean} expirePassword - expirar senha
 */
function generateBulkDisableScript(users, reason, moveOu, targetOu, expirePassword) {
  const timestamp = new Date().toLocaleString('pt-BR');

  const lines = [
    `# ================================================================`,
    `# Script de Desabilitação em LOTE no Active Directory`,
    `# Gerado em: ${timestamp}`,
    `# Total de contas: ${users.length}`,
    ...(reason ? [`# Motivo  : ${reason}`] : []),
    `# ================================================================`,
    ``,
    `Import-Module ActiveDirectory -ErrorAction Stop`,
    ``,
    `# ── Lista de usuários ───────────────────────────────────────────`,
    `$Usuarios = @(`,
    ...users.map((u, i) => {
      const comma = i < users.length - 1 ? ',' : '';
      return `    "${u.sam}"${comma}    # ${u.displayName || u.sam}`;
    }),
    `)`,
    ``,
    ...(reason ? [`$Motivo = "${reason}"`] : []),
    ...(moveOu && targetOu ? [`$TargetOU = "${targetOu}"`] : []),
    ``,
    `# ── Processar cada usuário ──────────────────────────────────────`,
    `$Sucesso = 0`,
    `$Falha   = 0`,
    ``,
    `foreach ($Sam in $Usuarios) {`,
    `    Write-Host ""`,
    `    Write-Host "▶ Processando: $Sam" -ForegroundColor Cyan`,
    `    try {`,
    `        $User = Get-ADUser -Identity $Sam -ErrorAction Stop`,
    ``,
    `        # Desabilitar conta`,
    `        Disable-ADAccount -Identity $Sam -ErrorAction Stop`,
    `        Write-Host "  ✅ Conta desabilitada." -ForegroundColor Green`,
  ];

  if (expirePassword) {
    lines.push(
      ``,
      `        # Expirar senha`,
      `        Set-ADUser -Identity $Sam -PasswordNeverExpires $false -ErrorAction SilentlyContinue`,
      `        Set-ADUser -Identity $Sam -ChangePasswordAtLogon $true -ErrorAction SilentlyContinue`,
      `        Write-Host "  🔑 Senha expirada." -ForegroundColor Cyan`,
    );
  }

  if (moveOu && targetOu) {
    lines.push(
      ``,
      `        # Mover para OU de desabilitados`,
      `        Move-ADObject -Identity $User.DistinguishedName -TargetPath $TargetOU -ErrorAction Stop`,
      `        Write-Host "  📂 Movido para: $TargetOU" -ForegroundColor Cyan`,
    );
  }

  if (reason) {
    lines.push(
      ``,
      `        # Registrar motivo na descrição`,
      `        $DataHoje = (Get-Date).ToString("dd/MM/yyyy")`,
      `        Set-ADUser -Identity $Sam -Description "DESABILITADO em $DataHoje - $Motivo" -ErrorAction SilentlyContinue`,
      `        Write-Host "  📝 Motivo registrado." -ForegroundColor Cyan`,
    );
  }

  lines.push(
    ``,
    `        $Sucesso++`,
    `    } catch {`,
    `        Write-Warning "  ❌ Falha em '$Sam': $_"`,
    `        $Falha++`,
    `    }`,
    `}`,
    ``,
    `# ── Resumo final ────────────────────────────────────────────────`,
    `Write-Host ""`,
    `Write-Host "═══════════════════════════════════" -ForegroundColor DarkGray`,
    `Write-Host "✅ Concluídos com sucesso : $Sucesso" -ForegroundColor Green`,
    `if ($Falha -gt 0) {`,
    `    Write-Host "❌ Com falha             : $Falha" -ForegroundColor Red`,
    `}`,
    `Write-Host "═══════════════════════════════════" -ForegroundColor DarkGray`,
  );

  return lines.join('\n');
}


/* ═══════════════════════════════════════════════════════════════
   DESABILITAR EM LOTE — UI: busca + lista + gerar script
═══════════════════════════════════════════════════════════════ */
(function () {
  const searchEl    = document.getElementById('disableBulkSearch');
  const clearEl     = document.getElementById('clearDisableBulkSearch');
  const dropEl      = document.getElementById('disableBulkDropdown');
  const listWrap    = document.getElementById('disableBulkListWrap');
  const listEl      = document.getElementById('disableBulkList');
  const listLabel   = document.getElementById('disableBulkListLabel');
  const clearAllEl  = document.getElementById('disableBulkClearAll');
  const countBadge  = document.getElementById('disableBulkCount');
  const genBtn      = document.getElementById('generateBulkDisableBtn');

  if (!searchEl) return;

  // Conjunto de usuários adicionados: Map<sam → userObj>
  const queueMap = new Map();

  function getUsers() {
    return (window.AD_DATA && window.AD_DATA.users) ? window.AD_DATA.users : [];
  }

  function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0][0].toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function hlText(text, term) {
    if (!term) return text;
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(`(${esc})`, 'gi'), '<mark>$1</mark>');
  }

  function filterUsers(term) {
    const t = term.toLowerCase();
    return getUsers().filter(u =>
      (u.samAccountName && u.samAccountName.toLowerCase().includes(t)) ||
      (u.displayName    && u.displayName.toLowerCase().includes(t))    ||
      (u.department     && u.department.toLowerCase().includes(t))
    ).slice(0, 12);
  }

  /* ── Renderiza dropdown de busca ── */
  function renderDrop(results, term) {
    dropEl.innerHTML = '';
    if (!results.length) {
      dropEl.innerHTML = `
        <div class="user-dropdown-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          Nenhum usuário encontrado
        </div>`;
      dropEl.style.display = 'block';
      return;
    }
    results.forEach(u => {
      const sam = u.samAccountName;
      const alreadyAdded = queueMap.has(sam);
      const isDisabled   = u.enabled === false;

      const item = document.createElement('div');
      item.className = 'user-dropdown-item';
      if (alreadyAdded) item.style.opacity = '.45';

      const initials = getInitials(u.displayName || sam);
      item.innerHTML = `
        <div class="user-dropdown-avatar" style="${isDisabled ? 'background:linear-gradient(135deg,#6b7280,#9ca3af)' : ''}">${initials}</div>
        <div class="user-dropdown-info">
          <div class="user-dropdown-name">
            ${hlText(u.displayName || sam, term)}
            ${isDisabled  ? '<span style="font-size:10px;background:#ef444420;color:#ef4444;border:1px solid #ef444430;border-radius:99px;padding:1px 7px;margin-left:6px;">Já desabilitado</span>' : ''}
            ${alreadyAdded ? '<span style="font-size:10px;background:#10b98118;color:#10b981;border:1px solid #10b98130;border-radius:99px;padding:1px 7px;margin-left:6px;">Na lista</span>' : ''}
          </div>
          <div class="user-dropdown-meta">
            <span class="user-dropdown-sam">${hlText(sam, term)}</span>
            ${u.department ? `<span class="user-dropdown-dept">${u.department}</span>` : ''}
          </div>
        </div>`;
      item.addEventListener('mousedown', e => {
        e.preventDefault();
        if (!alreadyAdded) addToQueue(u);
        else showToast(`${sam} já está na lista.`, '#f59e0b');
        searchEl.value = '';
        clearEl.style.display = 'none';
        dropEl.style.display  = 'none';
      });
      dropEl.appendChild(item);
    });
    dropEl.style.display = 'block';
  }

  /* ── Adiciona usuário à fila ── */
  function addToQueue(u) {
    const sam = u.samAccountName;
    if (queueMap.has(sam)) return;
    queueMap.set(sam, u);
    renderList();
    updateCounters();
    showToast(`${u.displayName || sam} adicionado! ✓`);
  }

  /* ── Remove usuário da fila ── */
  function removeFromQueue(sam) {
    queueMap.delete(sam);
    renderList();
    updateCounters();
  }

  /* ── Atualiza contadores e estado do botão ── */
  function updateCounters() {
    const n = queueMap.size;
    listLabel.textContent  = `${n} usuário${n !== 1 ? 's' : ''} na fila`;
    countBadge.textContent = n;
    countBadge.style.display = n > 0 ? 'inline-flex' : 'none';
    genBtn.disabled = n === 0;
    listWrap.style.display = n > 0 ? '' : 'none';
  }

  /* ── Renderiza itens da lista ── */
  function renderList() {
    listEl.innerHTML = '';
    queueMap.forEach((u, sam) => {
      const isDisabled = u.enabled === false;
      const initials   = getInitials(u.displayName || sam);

      const item = document.createElement('div');
      item.className = 'disable-bulk-item';
      item.innerHTML = `
        <div class="disable-bulk-item-avatar">${initials}</div>
        <div class="disable-bulk-item-info">
          <div class="disable-bulk-item-name">${u.displayName || sam}</div>
          <div class="disable-bulk-item-sam">${sam}${u.department ? ' · ' + u.department : ''}</div>
        </div>
        <span class="disable-bulk-item-status ${isDisabled ? 'disable-status-disabled' : 'disable-status-enabled'}">
          ${isDisabled ? '● Já desabilitado' : '● Ativa'}
        </span>
        <button class="disable-bulk-item-remove" title="Remover da lista">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>`;
      item.querySelector('.disable-bulk-item-remove').addEventListener('click', () => removeFromQueue(sam));
      listEl.appendChild(item);
    });
  }

  /* ── Eventos de busca ── */
  let debounce;
  searchEl.addEventListener('input', function () {
    const term = this.value.trim();
    clearEl.style.display = term ? 'flex' : 'none';
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (term.length < 2) { dropEl.style.display = 'none'; return; }
      const users = getUsers();
      if (!users.length) {
        // Sem AD: permite digitar SAM manualmente e adicionar
        dropEl.innerHTML = `
          <div class="user-dropdown-manual" style="cursor:pointer;" id="bulkManualAdd">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            AD não conectado — clique para adicionar <strong>${term}</strong> como SAM
          </div>`;
        const el = document.getElementById('bulkManualAdd');
        if (el) el.addEventListener('mousedown', e => {
          e.preventDefault();
          addToQueue({ samAccountName: term, displayName: term, enabled: true });
          searchEl.value = '';
          clearEl.style.display = 'none';
          dropEl.style.display  = 'none';
        });
        dropEl.style.display = 'block';
        return;
      }
      renderDrop(filterUsers(term), term);
    }, 200);
  });

  searchEl.addEventListener('focus', function () {
    const term = this.value.trim();
    if (term.length >= 2) renderDrop(filterUsers(term), term);
  });
  searchEl.addEventListener('blur', () => setTimeout(() => { dropEl.style.display = 'none'; }, 150));

  searchEl.addEventListener('keydown', function (e) {
    const items  = dropEl.querySelectorAll('.user-dropdown-item');
    const active = dropEl.querySelector('.user-dropdown-item.focused');
    if (e.key === 'Escape') { dropEl.style.display = 'none'; return; }
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = active ? active.nextElementSibling : items[0];
      active?.classList.remove('focused');
      if (next?.classList.contains('user-dropdown-item')) next.classList.add('focused');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = active?.previousElementSibling;
      active?.classList.remove('focused');
      if (prev?.classList.contains('user-dropdown-item')) prev.classList.add('focused');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active) {
        const idx = [...items].indexOf(active);
        const results = filterUsers(searchEl.value.trim());
        if (results[idx] && !queueMap.has(results[idx].samAccountName))
          addToQueue(results[idx]);
      }
    }
  });

  clearEl.addEventListener('click', () => {
    searchEl.value = '';
    clearEl.style.display = 'none';
    dropEl.style.display  = 'none';
  });

  clearAllEl.addEventListener('click', () => {
    if (!queueMap.size) return;
    if (confirm(`Remover todos os ${queueMap.size} usuários da lista?`)) {
      queueMap.clear();
      renderList();
      updateCounters();
    }
  });

  /* ── Toggle OU row ── */
  document.getElementById('disableBulkMoveOu').addEventListener('change', function () {
    document.getElementById('disableBulkOuRow').style.display = this.checked ? 'block' : 'none';
  });

  /* ── Gerar script em lote ── */
  genBtn.addEventListener('click', () => {
    if (!queueMap.size) { showToast('Adicione pelo menos um usuário.', '#f59e0b'); return; }

    const users        = [...queueMap.values()].map(u => ({ sam: u.samAccountName, displayName: u.displayName }));
    const reason       = document.getElementById('disableBulkReason').value.trim();
    const moveOu       = document.getElementById('disableBulkMoveOu').checked;
    const targetOu     = document.getElementById('disableBulkOuSelect').value.trim();
    const expirePw     = document.getElementById('disableBulkExpire').checked;

    const script = generateBulkDisableScript(users, reason, moveOu, targetOu, expirePw);

    const codeEl     = document.getElementById('disableBulkScriptCode');
    const outputEl   = document.getElementById('disableBulkScriptOutput');
    const emptyEl    = document.getElementById('disableBulkEmptyState');
    const actionsEl  = document.getElementById('disableBulkOutputActions');
    const summaryEl  = document.getElementById('disableBulkSummary');
    const summaryGrid= document.getElementById('disableBulkSummaryGrid');

    codeEl.innerHTML         = highlight(script);
    outputEl.style.display   = 'block';
    emptyEl.style.display    = 'none';
    actionsEl.style.display  = 'flex';

    // Summary
    summaryGrid.innerHTML = [
      { k: 'Total de contas',  v: `${users.length} usuários` },
      { k: 'Expirar Senha',    v: expirePw ? 'Sim' : 'Não' },
      { k: 'Mover para OU',    v: (moveOu && targetOu) ? targetOu : 'Não' },
      ...(reason ? [{ k: 'Motivo Global', v: reason }] : []),
      { k: 'Usuários', v: users.map(u => u.sam).join(', ') },
    ].map(i => `
      <div class="summary-item">
        <div class="s-key">${i.k}</div>
        <div class="s-val" style="word-break:break-all">${i.v}</div>
      </div>`).join('');
    summaryEl.style.display = 'block';

    document.getElementById('copyDisableBulkBtn')._script    = script;
    document.getElementById('downloadDisableBulkBtn')._script = script;
    document.getElementById('downloadDisableBulkBtn')._filename = `desabilitar_lote_${users.length}usuarios.ps1`;
    document.getElementById('executeDisableBulkBtn')._script  = script;

    showToast(`Script gerado para ${users.length} usuário(s)! ✓`);
  });

  document.getElementById('copyDisableBulkBtn').addEventListener('click', function () {
    if (this._script) copyText(this._script);
  });
  document.getElementById('downloadDisableBulkBtn').addEventListener('click', function () {
    if (this._script) downloadPS1(this._script, this._filename || 'desabilitar_lote.ps1');
  });

})();


/* ═══════════════════════════════════════════════════════════════
   SERVIDOR LOCAL — Integração Em Lote (Desabilitar)
═══════════════════════════════════════════════════════════════ */
(function () {
  const SERVER_PORT = (window.APP_CONFIG && window.APP_CONFIG.serverPort) ? window.APP_CONFIG.serverPort : 7510;
  const SERVER_BASE = `http://localhost:${SERVER_PORT}`;

  const execBtn     = document.getElementById('executeDisableBulkBtn');
  const termPanel   = document.getElementById('disableBulkTerminalPanel');
  const termOut     = document.getElementById('disableBulkTerminalOutput');
  const termSt      = document.getElementById('disableBulkTerminalStatus');

  async function getToken() {
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1800);
      const res   = await fetch(`${SERVER_BASE}/api/ping`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (execBtn) {
        execBtn.style.display = 'flex';
        execBtn.title = `Executar via servidor local (${data.user || 'localhost'})`;
      }
      return data.token;
    } catch {
      if (execBtn) execBtn.style.display = 'none';
      return null;
    }
  }

  function setStatus(type, text) {
    if (!termSt) return;
    termSt.textContent = text;
    termSt.className = `terminal-status-badge terminal-st-${type}`;
  }

  function addLine(text, hint) {
    const div = document.createElement('div');
    div.className = 'tline';
    const lower = (text || '').toLowerCase();
    if (hint === 'error' || text.includes('❌') || lower.includes('falha'))
      div.classList.add('tl-error');
    else if (text.includes('✅') || lower.includes('sucesso') || lower.includes('desabilitado'))
      div.classList.add('tl-success');
    else if (text.includes('⚠') || lower.includes('warning'))
      div.classList.add('tl-warn');
    else if (text.includes('🔑') || text.includes('📂') || text.includes('📝') || text.includes('▶') || hint === 'info')
      div.classList.add('tl-info');
    div.textContent = text || '\u00a0';
    termOut.appendChild(div);
    termOut.scrollTop = termOut.scrollHeight;
  }

  if (execBtn) {
    execBtn.addEventListener('click', async () => {
      const script = execBtn._script;
      if (!script) { showToast('Gere o script primeiro.', '#f59e0b'); return; }
      const token = await getToken();
      if (!token) { showToast('Servidor offline. Execute Start-Server.ps1.', '#f59e0b'); return; }

      termPanel.style.display = 'block';
      termOut.innerHTML = '';
      setStatus('running', '⏳ Executando...');
      addLine('⚡ Enviando script ao servidor local...', 'info');
      termPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      try {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 315000);
        const res = await fetch(`${SERVER_BASE}/api/run`, {
          method : 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Server-Token': token },
          body   : JSON.stringify({ script }),
          signal : ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Erro HTTP ${res.status}`);
        }
        const data = await res.json();
        termOut.innerHTML = '';
        for (const line of (data.lines || [])) {
          addLine(line);
          await new Promise(r => setTimeout(r, 20));
        }
        if (data.success) {
          setStatus('success', '✅ Concluído');
          showToast('Lote processado com sucesso! ✓');
        } else {
          setStatus('error', `❌ Falhou (código ${data.exitCode})`);
          showToast('Falhou — veja o terminal.', '#ef4444');
        }
      } catch (err) {
        addLine(`❌ ${err.message}`, 'error');
        setStatus('error', 'Erro de comunicação');
        showToast('Erro ao comunicar com o servidor.', '#ef4444');
      }
    });
  }

  document.getElementById('disableBulkTerminalClearBtn')?.addEventListener('click', () => {
    termOut.innerHTML = '';
    termPanel.style.display = 'none';
  });

  getToken();
  setInterval(getToken, 15000);
})();


/* ═══════════════════════════════════════════════════════════════
   DESABILITAR — OU PICKER (factory reutilizável)
   Usado em: Individual (disableOu*) e Em Lote (disableBulkOu*)
═══════════════════════════════════════════════════════════════ */
function initDisableOuPicker({ searchId, clearId, dropId, chipId, chipNameId, chipDnId, chipRemoveId, hiddenId }) {
  const searchEl = document.getElementById(searchId);
  const clearEl  = document.getElementById(clearId);
  const dropEl   = document.getElementById(dropId);
  const chipEl   = document.getElementById(chipId);
  const chipName = document.getElementById(chipNameId);
  const chipDn   = document.getElementById(chipDnId);
  const chipRem  = document.getElementById(chipRemoveId);
  const hiddenEl = document.getElementById(hiddenId);

  if (!searchEl || !window.AD_DATA) return;

  const ous = window.AD_DATA.ous || [];
  if (!ous.length) return;

  /** Retorna o caminho completo pai→filho como array de strings */
  function ouPath(ou) {
    return ou.distinguishedName
      .split(',')
      .filter(p => p.trim().toUpperCase().startsWith('OU='))
      .map(p => p.trim().slice(3))
      .reverse();
  }

  /** Ícone heurístico baseado no nome */
  function ouIcon(name) {
    const n = name.toLowerCase();
    if (/\b(user|usu[aá]r|people|pessoa)\b/.test(n)) return '👥';
    if (/\b(comp(ut)?|workst|pc|desktop|laptop)\b/.test(n)) return '💻';
    if (/\b(server|serv(id)?|srv)\b/.test(n)) return '🖥️';
    if (/\b(group|grupo|grp)\b/.test(n)) return '👪';
    if (/\b(admin|adm|priv)\b/.test(n)) return '🔐';
    if (/\b(print|impressora)\b/.test(n)) return '🖨️';
    if (/\b(ti|it|suporte|support|help)\b/.test(n)) return '🛠️';
    if (/\b(desat|disabled?|inativ)\b/.test(n)) return '🚫';
    if (/\b(terceiro|extern)\b/.test(n)) return '🤝';
    return '📁';
  }

  /** Lista ordenada: mais profundas primeiro, depois alfabética */
  const sorted = [...ous].sort((a, b) => {
    const da = a.distinguishedName.split(',').filter(p => p.toUpperCase().startsWith('OU=')).length;
    const db = b.distinguishedName.split(',').filter(p => p.toUpperCase().startsWith('OU=')).length;
    if (da !== db) return db - da;
    return a.distinguishedName.localeCompare(b.distinguishedName, 'pt-BR');
  });

  function filterOus(term) {
    if (!term) return sorted;
    const t = term.toLowerCase();
    return sorted.filter(ou =>
      ou.name.toLowerCase().includes(t) ||
      ou.distinguishedName.toLowerCase().includes(t) ||
      ouPath(ou).join(' ').toLowerCase().includes(t)
    );
  }

  function hl(text, term) {
    if (!term) return text;
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(`(${esc})`, 'gi'), '<mark>$1</mark>');
  }

  function renderDrop(results, term) {
    dropEl.innerHTML = '';
    if (!results.length) {
      dropEl.innerHTML = `<div class="bulk-ou-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        Nenhuma OU encontrada para "<strong>${term}</strong>"
      </div>`;
      dropEl.style.display = 'block';
      return;
    }

    const slice = results.slice(0, 80);
    slice.forEach((ou, idx) => {
      const path      = ouPath(ou);
      const leafName  = path[path.length - 1] || ou.name;
      const parentStr = path.slice(0, -1).join(' › ');
      const icon      = ouIcon(ou.name);

      const item = document.createElement('div');
      item.className = 'bulk-ou-drop-item';
      item.dataset.idx = idx;
      item.innerHTML = `
        <span class="bulk-ou-drop-icon">${icon}</span>
        <div class="bulk-ou-drop-info">
          <div class="bulk-ou-drop-leaf">
            ${hl(leafName, term)}
            ${parentStr ? `<span class="bulk-ou-drop-parent"> › ${hl(parentStr, term)}</span>` : ''}
          </div>
          <div class="bulk-ou-drop-dn">${hl(ou.distinguishedName, term)}</div>
        </div>`;
      item.addEventListener('mousedown', e => { e.preventDefault(); select(ou); });
      dropEl.appendChild(item);
    });

    if (results.length > 80) {
      const more = document.createElement('div');
      more.className = 'bulk-ou-drop-more';
      more.textContent = `+ ${results.length - 80} resultados — refine a busca`;
      dropEl.appendChild(more);
    }
    dropEl.style.display = 'block';
  }

  function select(ou) {
    const path = ouPath(ou);
    hiddenEl.value    = ou.distinguishedName;
    chipName.textContent = path.join(' › ');
    chipDn.textContent   = ou.distinguishedName;
    chipEl.querySelector('.bulk-ou-chip-icon').textContent = ouIcon(ou.name);
    chipEl.style.display = 'flex';
    searchEl.value = '';
    clearEl.style.display = 'none';
    dropEl.style.display  = 'none';
  }

  function clear() {
    hiddenEl.value = '';
    chipEl.style.display  = 'none';
    searchEl.value        = '';
    clearEl.style.display = 'none';
    dropEl.style.display  = 'none';
  }

  let debounce;
  searchEl.addEventListener('input', function () {
    clearEl.style.display = this.value ? 'flex' : 'none';
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const term = this.value.trim();
      if (!term) { dropEl.style.display = 'none'; return; }
      renderDrop(filterOus(term), term);
    }, 160);
  });

  searchEl.addEventListener('focus', function () {
    const term = this.value.trim();
    if (term) renderDrop(filterOus(term), term);
    else if (!hiddenEl.value) renderDrop(sorted.slice(0, 50), '');
  });

  searchEl.addEventListener('blur', () => setTimeout(() => { dropEl.style.display = 'none'; }, 160));

  searchEl.addEventListener('keydown', function (e) {
    const items  = dropEl.querySelectorAll('.bulk-ou-drop-item');
    const active = dropEl.querySelector('.bulk-ou-drop-item.focused');
    if (e.key === 'Escape') { dropEl.style.display = 'none'; return; }
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = active ? active.nextElementSibling : items[0];
      active?.classList.remove('focused');
      if (next?.classList.contains('bulk-ou-drop-item')) next.classList.add('focused');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = active?.previousElementSibling;
      active?.classList.remove('focused');
      if (prev?.classList.contains('bulk-ou-drop-item')) prev.classList.add('focused');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active) {
        const idx = +active.dataset.idx;
        const term = searchEl.value.trim();
        const results = filterOus(term);
        if (results[idx]) select(results[idx]);
      }
    }
  });

  clearEl.addEventListener('click', clear);
  chipRem.addEventListener('click', clear);
}

/* ── Inicializar os dois pickers de OU nos painéis de Desabilitar ── */
/* Aguarda AD_DATA estar disponível (pode já estar, ou ser injetado pelo ad-data.js) */
(function () {
  function tryInit() {
    if (!window.AD_DATA || !window.AD_DATA.ous || !window.AD_DATA.ous.length) return;

    initDisableOuPicker({
      searchId:    'disableOuSearch',
      clearId:     'disableOuClear',
      dropId:      'disableOuDrop',
      chipId:      'disableOuChip',
      chipNameId:  'disableOuChipName',
      chipDnId:    'disableOuChipDn',
      chipRemoveId:'disableOuChipRemove',
      hiddenId:    'disableOuSelect',
    });

    initDisableOuPicker({
      searchId:    'disableBulkOuSearch',
      clearId:     'disableBulkOuClear',
      dropId:      'disableBulkOuDrop',
      chipId:      'disableBulkOuChip',
      chipNameId:  'disableBulkOuChipName',
      chipDnId:    'disableBulkOuChipDn',
      chipRemoveId:'disableBulkOuChipRemove',
      hiddenId:    'disableBulkOuSelect',
    });
  }

  // Tenta imediatamente (ad-data.js já pode ter sido carregado antes deste script)
  tryInit();

  // Caso contrário, aguarda o evento DOMContentLoaded e tenta novamente
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInit);
  }

  // Fallback com polling (caso ad-data.js carregue de forma assíncrona)
  let attempts = 0;
  const interval = setInterval(() => {
    if (window.AD_DATA?.ous?.length || ++attempts > 30) {
      clearInterval(interval);
      tryInit();
    }
  }, 300);
})();


/* ═══════════════════════════════════════════════════════════════
   MONITOR DE USUÁRIOS BLOQUEADOS
   Polling a cada 60s via Start-Server.ps1 → Get-ADUser LockedOut
   Botão Desbloquear executa Unlock-ADAccount via /api/run
═══════════════════════════════════════════════════════════════ */
(function LockedUsersMonitor() {
  const SERVER_PORT   = (window.APP_CONFIG && window.APP_CONFIG.serverPort) ? window.APP_CONFIG.serverPort : 7510;
  const SERVER_BASE   = 'http://localhost:' + SERVER_PORT;
  const POLL_INTERVAL = 60;

  const offlineBanner = document.getElementById('lockedOfflineBanner');
  const statusBar     = document.getElementById('lockedStatusBar');
  const statusDot     = document.getElementById('lockedStatusDot');
  const statusText    = document.getElementById('lockedStatusText');
  const lastCheckEl   = document.getElementById('lockedLastCheck');
  const countdownEl   = document.getElementById('lockedCountdown');
  const countdownWrap = document.getElementById('lockedCountdownWrap');
  const checkNowBtn   = document.getElementById('lockedCheckNow');
  const tableEl       = document.getElementById('lockedTable');
  const tableBody     = document.getElementById('lockedTableBody');
  const emptyEl       = document.getElementById('lockedEmpty');
  const initialEl     = document.getElementById('lockedInitial');
  const tabBadge      = document.getElementById('lockedTabBadge');
  const termPanel     = document.getElementById('lockedTerminalPanel');
  const termOut       = document.getElementById('lockedTerminalOutput');
  const termSt        = document.getElementById('lockedTerminalStatus');
  const termClearBtn  = document.getElementById('lockedTerminalClearBtn');

  if (!tableEl) return;

  let serverToken    = null;
  let countdownTimer = null;
  let secondsLeft    = POLL_INTERVAL;
  let isChecking     = false;
  let allLockedUsers = [];

  const QUERY_SCRIPT = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Import-Module ActiveDirectory -ErrorAction Stop',
    '$locked = @(Search-ADAccount -LockedOut -UsersOnly -ErrorAction Stop | Get-ADUser -Properties DisplayName,SamAccountName,LockedOut,BadLogonCount,LastBadPasswordAttempt,Department,Title,Enabled -ErrorAction Stop)',
    '$arr = @($locked | ForEach-Object {',
    '    [PSCustomObject]@{',
    '        sam        = [string]$_.SamAccountName',
    '        display    = if ($_.DisplayName) { [string]$_.DisplayName } else { [string]$_.SamAccountName }',
    '        department = if ($_.Department)  { [string]$_.Department  } else { "" }',
    '        title      = if ($_.Title)       { [string]$_.Title       } else { "" }',
    '        badCount   = [int]$(if ($_.BadLogonCount) { $_.BadLogonCount } else { 0 })',
    '        lastBad    = if ($_.LastBadPasswordAttempt) { $_.LastBadPasswordAttempt.ToString("dd/MM/yyyy HH:mm:ss") } else { "" }',
    '        enabled    = ($_.Enabled -eq $true)',
    '    }',
    '})',
    '$json = if ($arr.Count -eq 0) { "[]" } elseif ($arr.Count -eq 1) { "[" + ($arr[0] | ConvertTo-Json -Depth 2 -Compress) + "]" } else { $arr | ConvertTo-Json -Depth 2 -Compress }',
    'Write-Output $json',
  ].join('\n');

  function buildUnlockScript(sam) {
    var e = sam.replace(/'/g, "''");
    return [
      'Import-Module ActiveDirectory -ErrorAction Stop',
      'try {',
      "    Unlock-ADAccount -Identity '" + e + "' -ErrorAction Stop",
      "    Write-Host \"[OK] Conta '" + e + "' desbloqueada com sucesso!\"",
      "    $u = Get-ADUser -Identity '" + e + "' -Properties LockedOut -ErrorAction SilentlyContinue",
      '    if ($u -and -not $u.LockedOut) { Write-Host "   Verificado: conta agora desbloqueada." }',
      '} catch {',
      "    Write-Error \"[ERRO] Falha ao desbloquear '" + e + "': $_\"",
      '    exit 1',
      '}',
    ].join('\n');
  }

  async function pingServer() {
    try {
      var ctrl  = new AbortController();
      var timer = setTimeout(function() { ctrl.abort(); }, 1800);
      var res   = await fetch(SERVER_BASE + '/api/ping', { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error();
      var data  = await res.json();
      serverToken = data.token;
      return true;
    } catch (_) { serverToken = null; return false; }
  }

  async function runScript(scriptContent) {
    var online = await pingServer();
    if (!online || !serverToken) return null;
    var ctrl  = new AbortController();
    var timer = setTimeout(function() { ctrl.abort(); }, 60000);
    try {
      var res = await fetch(SERVER_BASE + '/api/run', {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Server-Token': serverToken },
        body   : JSON.stringify({ script: scriptContent }),
        signal : ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 401) { serverToken = null; return null; }
      if (!res.ok) return null;
      return await res.json();
    } catch (_) { clearTimeout(timer); return null; }
  }

  function setStatus(state, text) {
    if (!statusBar) return;
    statusBar.style.display = 'flex';
    if (statusDot)  statusDot.className   = 'locked-status-dot locked-dot-' + state;
    if (statusText) statusText.textContent = text;
  }

  function setTermStatus(type, text) {
    if (!termSt) return;
    termSt.textContent = text;
    termSt.className   = 'terminal-status-badge terminal-st-' + type;
  }

  function addTermLine(text, hint) {
    if (!termOut) return;
    var div   = document.createElement('div');
    div.className = 'tline';
    var lower = (text || '').toLowerCase();
    if (hint === 'error' || text.includes('[ERRO]') || lower.includes('falha') || lower.includes('error'))
      div.classList.add('tl-error');
    else if (text.includes('[OK]') || lower.includes('sucesso') || lower.includes('desbloqueada'))
      div.classList.add('tl-success');
    else if (text.includes('[AVISO]') || lower.includes('warning'))
      div.classList.add('tl-warn');
    else if (hint === 'info')
      div.classList.add('tl-info');
    div.textContent = text || '\u00a0';
    termOut.appendChild(div);
    termOut.scrollTop = termOut.scrollHeight;
  }

  function renderTable(users) {
    var count = users.length;
    if (tabBadge) { tabBadge.textContent = count; tabBadge.style.display = count > 0 ? 'inline-flex' : 'none'; }
    if (initialEl) initialEl.style.display = 'none';

    if (count === 0) {
      if (tableEl) tableEl.style.display = 'none';
      if (emptyEl) emptyEl.style.display = 'flex';
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';
    if (tableEl) {
      tableEl.style.display = '';
      tableEl.classList.remove('locked-table-flash');
      void tableEl.offsetWidth;
      tableEl.classList.add('locked-table-flash');
    }

    tableBody.innerHTML = '';
    users.forEach(function(u, i) {
      var name    = u.display || u.sam || '';
      var parts   = name.trim().split(/\s+/);
      var initials = parts.length > 1
        ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
        : name.slice(0, 2).toUpperCase();

      var unlockIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="locked-td-num">' + (i + 1) + '</td>' +
        '<td class="locked-td-user"><div class="locked-user-cell">' +
          '<div class="locked-avatar">' + escapeHTML(initials) + '</div>' +
          '<div><div class="locked-user-name">' + escapeHTML(name) + '</div>' +
            (u.title ? '<div class="locked-user-title">' + escapeHTML(u.title) + '</div>' : '') +
          '</div></div></td>' +
        '<td><code class="locked-sam">' + escapeHTML(u.sam) + '</code></td>' +
        '<td>' + (u.department ? escapeHTML(u.department) : '<span style="opacity:.4">—</span>') + '</td>' +
        '<td class="locked-td-time">' + (u.lastBad ? escapeHTML(u.lastBad) : '<span style="opacity:.4">—</span>') + '</td>' +
        '<td class="locked-td-count"><span class="locked-bad-count">' + (u.badCount || 0) + '</span></td>' +
        '<td><button class="btn-unlock" data-sam="' + escapeHTML(u.sam) + '">' + unlockIcon + ' Desbloquear</button></td>';
      tableBody.appendChild(tr);
    });

    tableBody.querySelectorAll('.btn-unlock').forEach(function(btn) {
      btn.addEventListener('click', function() { unlockUser(btn.dataset.sam, btn); });
    });
  }

  async function unlockUser(sam, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Aguarde...'; }
    if (termPanel) termPanel.style.display = 'block';
    if (termOut)   termOut.innerHTML = '';
    setTermStatus('running', 'Desbloqueando...');
    addTermLine('Desbloqueando conta: ' + sam, 'info');
    if (termPanel) termPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    var result = await runScript(buildUnlockScript(sam));

    if (!result) {
      setTermStatus('error', 'Erro de comunicacao');
      addTermLine('[ERRO] Servidor offline ou erro de comunicacao.', 'error');
      showToast('Servidor offline.', '#ef4444');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg> Desbloquear';
      }
      return;
    }

    for (var i = 0; i < (result.lines || []).length; i++) {
      addTermLine(result.lines[i]);
      await new Promise(function(r) { setTimeout(r, 25); });
    }

    if (result.success) {
      setTermStatus('success', 'Desbloqueado');
      showToast(sam + ' desbloqueado com sucesso!');
      var row = btn && btn.closest('tr');
      if (row) {
        row.classList.add('locked-row-fade');
        setTimeout(function() {
          row.remove();
          var remaining = tableBody ? tableBody.querySelectorAll('tr').length : 0;
          if (tabBadge) { tabBadge.textContent = remaining; tabBadge.style.display = remaining > 0 ? 'inline-flex' : 'none'; }
          if (remaining === 0) { if (tableEl) tableEl.style.display = 'none'; if (emptyEl) emptyEl.style.display = 'flex'; }
        }, 500);
      }
    } else {
      setTermStatus('error', 'Falha');
      showToast('Falha ao desbloquear ' + sam + '.', '#ef4444');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg> Desbloquear';
      }
    }
  }

  async function checkLockedUsers() {
    if (isChecking) return;
    isChecking = true;
    if (checkNowBtn) checkNowBtn.disabled = true;
    setStatus('checking', 'Verificando usuarios bloqueados...');

    var online = await pingServer();

    if (!online) {
      if (offlineBanner) offlineBanner.style.display = 'flex';
      if (countdownWrap) countdownWrap.style.display = 'none';
      if (checkNowBtn)   checkNowBtn.disabled = true;
      if (statusBar)     statusBar.style.display = 'none';
      isChecking = false;
      return;
    }

    if (offlineBanner) offlineBanner.style.display = 'none';
    if (checkNowBtn)   checkNowBtn.disabled = false;
    if (countdownWrap) countdownWrap.style.display = 'flex';

    var result = await runScript(QUERY_SCRIPT);

    if (!result) {
      setStatus('error', 'Erro ao consultar o AD');
      isChecking = false;
      return;
    }

    var users = [];
    try {
      var jsonLine = (result.lines || []).find(function(l) {
        var t = l.trim();
        return t.startsWith('[') || t.startsWith('{');
      });
      if (jsonLine) {
        var parsed = JSON.parse(jsonLine);
        users = Array.isArray(parsed) ? parsed : [parsed];
      }
    } catch (_) { users = []; }

    allLockedUsers = users;
    applyLockedFilter();

    resetCountdown();
    isChecking = false;
  }

  function applyLockedFilter() {
    let users = allLockedUsers;
    const filterTodayEl = document.getElementById('lockedFilterToday');
    if (filterTodayEl && filterTodayEl.checked) {
      const now = new Date();
      const dd = String(now.getDate()).padStart(2, '0');
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const yyyy = now.getFullYear();
      const prefix = dd + '/' + mm + '/' + yyyy;
      
      users = users.filter(function(u) {
        return u.lastBad && u.lastBad.startsWith(prefix);
      });
    }

    renderTable(users);
    var nowStr = new Date().toLocaleTimeString('pt-BR');
    setStatus(users.length > 0 ? 'warn' : 'ok', users.length + ' usuario(s) exibido(s) (' + allLockedUsers.length + ' total)');
    if (lastCheckEl) lastCheckEl.textContent = 'Ultima verificacao: ' + nowStr;
  }

  const filterTodayEl = document.getElementById('lockedFilterToday');
  if (filterTodayEl) {
    filterTodayEl.addEventListener('change', applyLockedFilter);
  }

  function resetCountdown() {
    clearInterval(countdownTimer);
    secondsLeft = POLL_INTERVAL;
    if (countdownEl) countdownEl.textContent = secondsLeft;
    countdownTimer = setInterval(function() {
      secondsLeft--;
      if (countdownEl) countdownEl.textContent = Math.max(0, secondsLeft);
      if (secondsLeft <= 0) { clearInterval(countdownTimer); checkLockedUsers(); }
    }, 1000);
  }

  if (checkNowBtn) {
    checkNowBtn.addEventListener('click', function() {
      clearInterval(countdownTimer);
      checkLockedUsers();
    });
  }

  if (termClearBtn) {
    termClearBtn.addEventListener('click', function() {
      if (termOut)   termOut.innerHTML = '';
      if (termPanel) termPanel.style.display = 'none';
    });
  }

  window._lockedMonitorCheckNow = checkLockedUsers;

  pingServer().then(function(online) {
    if (online) {
      if (offlineBanner) offlineBanner.style.display = 'none';
      if (checkNowBtn)   checkNowBtn.disabled = false;
    } else {
      if (offlineBanner) offlineBanner.style.display = 'flex';
    }
  });
})();
