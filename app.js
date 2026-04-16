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
    `# Importa os módulos necessários`,
    `Import-Module ActiveDirectory -ErrorAction Stop`,
    `Import-Module Microsoft.PowerShell.Security -ErrorAction SilentlyContinue`,
    ``,
    `# ── Dados do Usuário ────────────────────────────────────────────`,
    `$FirstName    = "${firstName}"`,
    `$LastName     = "${lastNameField}"`,
    `$FullName     = "${displayName}"`,
    `$SamAccount   = "${sam}"`,
    `$UPN          = "${email}"`,
    `$Email        = "${email}"`,
    `$CPF          = "${cpf11}"         # CPF sem pontuação, 11 dígitos`,
    `$OU           = ${ouLine}`,
    `$Password     = ConvertTo-SecureString "${password}" -AsPlainText -Force`,
    ``,
    `# ── Criar Usuário ───────────────────────────────────────────────`,
    `try {`,
    `    New-ADUser \``,
    `        -Name              $FullName \``,
    `        -GivenName         $FirstName \``,
    `        -Surname           $LastName \``,
    `        -SamAccountName    $SamAccount \``,
    `        -UserPrincipalName $UPN \``,
    `        -EmailAddress      $Email \``,
    `        -Description       $CPF \``,
    `        -Path              $OU \``,
    `        -AccountPassword   $Password \``,
    `        -Enabled           $${enabled ? 'true' : 'false'} \``,
    `        -ChangePasswordAtLogon $${mustChange ? 'true' : 'false'}`,
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
      `$Modelo = "${templateUser}"`,
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
  const defaultOU = `"OU=Usuarios,${dcParts}"`;

  const header = [
    `# ================================================================`,
    `# Script de Criação de Usuários em LOTE no Active Directory`,
    `# Gerado em: ${new Date().toLocaleString('pt-BR')}`,
    `# Total de usuários: ${users.length}`,
    `# ================================================================`,
    ``,
    `Import-Module ActiveDirectory -ErrorAction Stop`,
    `Import-Module Microsoft.PowerShell.Security -ErrorAction SilentlyContinue`,
    ``,
    `$usuarios = @(`,
  ];

  const userLines = users.map((u, i) => {
    const comma = i < users.length - 1 ? ',' : '';
    const lastNameField = u.surnames || u.lastName;
    return [
      `    @{`,
      `        FirstName   = "${u.firstName}"`,
      `        LastName    = "${lastNameField}"`,
      `        FullName    = "${u.firstName} ${lastNameField}"`,
      `        Sam         = "${u.sam}"`,
      `        Email       = "${u.email}"`,
      `        CPF         = "${u.cpf11}"`,
      `        OU          = ${u.ou ? `"${u.ou}"` : defaultOU}`,
      `        Password    = "${u.password}"`,
      `    }${comma}`,
    ].join('\n');
  });

  // Bloco de cópia de grupos para lote (se modelo informado)
  const templateBlock = templateUser && templateUser.trim() ? [
    ``,
    `        # ── Copiar grupos do modelo ──────────────────────────────────`,
    `        try {`,
    `            $Grupos = Get-ADPrincipalGroupMembership -Identity "${templateUser}" |`,
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
    `    try {`,
    `        $SecPw = ConvertTo-SecureString $u.Password -AsPlainText -Force`,
    `        $OUFINAL = if ($u.OU) { $u.OU } else { ${defaultOU} }`,
    ``,
    `        New-ADUser \``,
    `            -Name              "$($u.FullName)" \``,
    `            -GivenName         $u.FirstName \``,
    `            -Surname           $u.LastName \``,
    `            -SamAccountName    $u.Sam \``,
    `            -UserPrincipalName $u.Email \``,
    `            -EmailAddress      $u.Email \``,
    `            -Description       $u.CPF \``,
    `            -Path              $u.OU \``,
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

  // Validate senha
  if (!password || password.length < 6) {
    pwHint.textContent = 'Mínimo 6 caracteres.'; pwHint.style.color = 'var(--danger)'; valid = false;
  }

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
document.getElementById('downloadBtn').addEventListener('click', function () {
  if (this._script) downloadPS1(this._script, this._filename || 'criar_usuario_ad.ps1');
});

/* ---------- CSV Bulk ---------- */

function parseCsvLine(line) {
  return line.split(',').map(s => s.trim());
}

/**
 * Resolve um texto de OU (nome, DN parcial ou DN completo) para o DN exato do AD.
 * Se o AD_DATA não estiver disponível, retorna o texto como está (se parecer um DN)
 * ou null.
 */
function resolveOuFromInput(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Se tivermos dados do AD, tenta resolver pelo mapa
  if (window.AD_DATA && window.AD_DATA.ous && window.AD_DATA.ous.length) {
    const resolved = resolveOuByName(trimmed);
    if (resolved) return resolved;
  }

  // Sem AD_DATA: se parece um DN (contém '='), usa diretamente
  if (trimmed.includes('=')) return trimmed;

  // Senão, não sabe o DN
  return null;
}

document.getElementById('bulkBtn').addEventListener('click', function () {
  const raw   = document.getElementById('csvInput').value.trim();
  if (!raw) { showToast('Cole o CSV antes de gerar.', '#f59e0b'); return; }

  const domain = domainInput.value.trim() || 'orsegups.com.br';
  const lines  = raw.split('\n').filter(l => l.trim());

  // Detecta cabeçalho
  const firstLine = lines[0].toLowerCase();
  const hasHeader = firstLine.includes('nome') || firstLine.includes('first') || firstLine.includes('cpf');
  const dataLines = hasHeader ? lines.slice(1) : lines;

  if (!dataLines.length) { showToast('Nenhum dado encontrado no CSV.', '#f59e0b'); return; }

  // OU Global: seletor de regional/setor ou OU padrão
  const bulkOuSelect = document.getElementById('bulkOuSelect');
  const globalOU = bulkOuSelect ? bulkOuSelect.value : '';

  const users = dataLines.map(line => {
    const [fullNameCsv = '', cpfRaw = '', ouRaw = '', password = 'Mudar@2025'] = parseCsvLine(line);
    const { first, last } = parseFullName(fullNameCsv.trim());
    const fn    = normalizeStr(first);
    const ln    = normalizeStr(last);
    const cpf11 = normalizeCPF(cpfRaw) || '00000000000';
    const sam   = ln ? `${fn}.${ln}` : fn;
    const email = `${sam}@${domain}`;

    // Resolução de OU: prioridade CSV → seletor global → vazio (padrão do domínio)
    const ouResolved = resolveOuFromInput(ouRaw.trim()) ||
                       resolveOuFromInput(globalOU)     ||
                       '';

    return { firstName: first, lastName: last, surnames, sam, email, cpf11, ou: ouResolved, password };
  }).filter(u => u.firstName && u.lastName);

  if (!users.length) { showToast('Nenhum usuário válido encontrado.', '#ef4444'); return; }

  // Mostra quais OUs foram resolvidas / não resolvidas
  const unresolved = users.filter(u => !u.ou);
  if (unresolved.length) {
    showToast(`⚠ ${unresolved.length} usuário(s) sem OU — será usada a padrão do domínio.`, '#f59e0b');
  }

  const templateUserBulk = document.getElementById('templateUser').value.trim();
  const script = generateBulkScript(users, domain, templateUserBulk);

  const bulkCode      = document.getElementById('bulkCode');
  const bulkOutput    = document.getElementById('bulkOutput');
  const bulkEmpty     = document.getElementById('bulkEmptyState');
  const bulkActions   = document.getElementById('bulkOutputActions');

  bulkCode.innerHTML = highlight(script);
  bulkOutput.style.display  = 'block';
  bulkEmpty.style.display   = 'none';
  bulkActions.style.display = 'flex';

  document.getElementById('copyBulkBtn')._script   = script;
  document.getElementById('downloadBulkBtn')._script   = script;
  document.getElementById('downloadBulkBtn')._filename = 'criar_usuarios_lote.ps1';

  showToast(`${users.length} usuário(s) processado(s)! ✓`);
});

document.getElementById('copyBulkBtn').addEventListener('click', function () {
  if (this._script) copyText(this._script);
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

function closeModal()  { ouModal.style.display = 'none'; }
closeOuModalBtn.addEventListener('click',  closeModal);
cancelOuModalBtn.addEventListener('click', closeModal);
ouModal.addEventListener('click', e => { if (e.target === ouModal) closeModal(); });

confirmOuModalBtn.addEventListener('click', () => {
  selectedNode = pendingNode;
  applySelection();
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
    ouTree.forEach(node => renderNode(node, [], childrenWrap, filter, domain));
    adTreeEl.appendChild(childrenWrap);
  }
}

function renderNode(node, parentTrail, container, filter, domain) {
  const trail = [...parentTrail, node.name];
  // Prioridade: DN exato do AD → DN calculado como fallback
  const dn    = node.exactDn || buildDN(trail, domain);
  const hasChildren = !!(node.children && node.children.length);

  const matchesSelf  = !filter || node.name.toLowerCase().includes(filter.toLowerCase());
  const childrenHit  = hasChildren && nodeOrChildMatches(node, filter);
  if (filter && !matchesSelf && !childrenHit) return;

  const { wrapper } = createNodeRow({
    id: node.id, name: node.name, icon: node.icon || '📁',
    trail, dn, isRoot: false, hasChildren, filter,
    hasExactDn: !!node.exactDn,
  });
  container.appendChild(wrapper);

  if (hasChildren && expandedIds.has(node.id)) {
    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'tree-children';
    node.children.forEach(child => renderNode(child, trail, childrenWrap, filter, domain));
    wrapper.appendChild(childrenWrap);
  }
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
    return;
  }
  detailIconEl.textContent = '📂';
  detailNameEl.textContent = node.name;
  detailDnEl.textContent   = node.dn;
  selectedPathEl.textContent = node.dn;
  selectedPathEl.classList.add('active');
}

treeSearchEl.addEventListener('input', function () {
  const term = this.value.trim();
  if (term) { expandAll(ouTree); expandedIds.add('__root__'); }
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

      /** Lista canônica de OUs ordenada por profundidade depois alfabética */
      const sorted = [...ous].sort((a, b) => {
        const da = a.distinguishedName.split(',').filter(p => p.toUpperCase().startsWith('OU=')).length;
        const db = b.distinguishedName.split(',').filter(p => p.toUpperCase().startsWith('OU=')).length;
        return da !== db ? da - db : a.name.localeCompare(b.name, 'pt-BR');
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

        // Limita a 60 resultados para performance
        const slice = results.slice(0, 60);
        slice.forEach((ou, idx) => {
          const path  = ouPath(ou);
          const icon  = guessOuIcon(ou.name);
          const label = path.join(' › ');

          const item = document.createElement('div');
          item.className = 'bulk-ou-drop-item';
          item.dataset.idx = idx;
          item.innerHTML = `
            <span class="bulk-ou-drop-icon">${icon}</span>
            <div class="bulk-ou-drop-info">
              <div class="bulk-ou-drop-path">${hl(label, term)}</div>
              <div class="bulk-ou-drop-dn">${hl(ou.distinguishedName, term)}</div>
            </div>`;
          item.addEventListener('mousedown', e => {
            e.preventDefault();
            select(ou);
          });
          dropEl.appendChild(item);
        });

        if (results.length > 60) {
          const more = document.createElement('div');
          more.className = 'bulk-ou-drop-more';
          more.textContent = `+ ${results.length - 60} resultados — refine a busca`;
          dropEl.appendChild(more);
        }

        dropEl.style.display = 'block';
      }

      /** Seleciona uma OU */
      function select(ou) {
        hiddenEl.value = ou.distinguishedName;
        chipName.textContent = ouPath(ou).join(' › ');
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
        else if (!hiddenEl.value) renderDrop(sorted.slice(0, 30), ''); // mostra top-30 ao abrir
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
   USUÁRIO MODELO — Autocomplete
   Busca contra window.AD_DATA.users (exportado pelo Get-ADData.ps1).
   Se AD_DATA não disponível, permite digitar manualmente o SAM.
═══════════════════════════════════════════════════════════════ */

(function () {
  const searchInput    = document.getElementById('templateUserSearch');
  const dropdown       = document.getElementById('userDropdown');
  const hiddenInput    = document.getElementById('templateUser');
  const chip           = document.getElementById('templateChip');
  const chipAvatar     = document.getElementById('templateChipAvatar');
  const chipName       = document.getElementById('templateChipName');
  const chipSam        = document.getElementById('templateChipSam');
  const clearBtn       = document.getElementById('clearTemplateUser');
  const removeBtn      = document.getElementById('removeTemplateUser');

  let selectedUser = null;
  let debounceTimer = null;

  /** Obtém a lista de usuários do AD_DATA ou retorna array vazio */
  function getUsers() {
    return (window.AD_DATA && window.AD_DATA.users) ? window.AD_DATA.users : [];
  }

  /** Retorna as iniciais do displayName para o avatar */
  function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0][0].toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  /** Destaca o termo buscado no texto */
  function highlight(text, term) {
    if (!term) return text;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
  }

  /** Filtra a lista de usuários pelo termo digitado */
  function filterUsers(term) {
    const t = term.toLowerCase();
    return getUsers().filter(u =>
      (u.samAccountName && u.samAccountName.toLowerCase().includes(t)) ||
      (u.displayName    && u.displayName.toLowerCase().includes(t))    ||
      (u.department     && u.department.toLowerCase().includes(t))
    ).slice(0, 10); // máx 10 resultados
  }

  /** Renderiza o dropdown com os resultados */
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
      item.innerHTML = `
        <div class="user-dropdown-avatar">${initials}</div>
        <div class="user-dropdown-info">
          <div class="user-dropdown-name">${highlight(u.displayName || u.samAccountName, term)}</div>
          <div class="user-dropdown-meta">
            <span class="user-dropdown-sam">${highlight(u.samAccountName, term)}</span>
            ${u.department ? `<span class="user-dropdown-dept">${u.department}</span>` : ''}
          </div>
        </div>`;
      item.addEventListener('mousedown', e => {
        e.preventDefault(); // evita blur antes do click
        selectUser(u);
      });
      dropdown.appendChild(item);
    });

    dropdown.style.display = 'block';
  }

  /** Seleciona um usuário modelo */
  function selectUser(u) {
    selectedUser = u;
    hiddenInput.value = u.samAccountName;

    // Mostra chip
    const initials = getInitials(u.displayName || u.samAccountName);
    chipAvatar.textContent = initials;
    chipName.textContent   = u.displayName || u.samAccountName;
    chipSam.textContent    = u.samAccountName
      + (u.department ? ` · ${u.department}` : '')
      + (u.title      ? ` · ${u.title}`      : '');
    chip.style.display = 'flex';

    // Limpa input de busca
    searchInput.value     = '';
    clearBtn.style.display = 'none';
    dropdown.style.display = 'none';
  }

  /** Remove o usuário modelo selecionado */
  function clearSelection() {
    selectedUser      = null;
    hiddenInput.value = '';
    chip.style.display = 'none';
    searchInput.value = '';
    clearBtn.style.display = 'none';
  }

  /* ── Eventos ── */

  searchInput.addEventListener('input', function () {
    const term = this.value.trim();
    clearBtn.style.display = term ? 'flex' : 'none';

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (term.length < 2) {
        dropdown.style.display = 'none';
        return;
      }

      const users = getUsers();
      if (!users.length) {
        // Sem AD_DATA: aceita o SAM digitado diretamente
        hiddenInput.value      = term;
        dropdown.innerHTML     = `
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

      const results = filterUsers(term);
      renderDropdown(results, term);
    }, 200);
  });

  searchInput.addEventListener('keydown', function (e) {
    const items = dropdown.querySelectorAll('.user-dropdown-item');
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
        const idx = [...items].indexOf(active);
        const results = filterUsers(searchInput.value.trim());
        if (results[idx]) selectUser(results[idx]);
      }
    }
  });

  searchInput.addEventListener('blur', () => {
    // Pequeno delay para permitir o mousedown do item
    setTimeout(() => { dropdown.style.display = 'none'; }, 150);
  });

  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim().length >= 2) {
      renderDropdown(filterUsers(searchInput.value.trim()), searchInput.value.trim());
    }
  });

  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.style.display = 'none';
    dropdown.style.display = 'none';
    hiddenInput.value = '';
  });

  removeBtn.addEventListener('click', clearSelection);
})();

/* ═══════════════════════════════════════════════════════════════
   SERVIDOR LOCAL — Integração com Start-Server.ps1
   Fluxo:
     1. checkServer() → GET /api/ping → recebe token de sessão
     2. executeScript() → POST /api/run com {script: "..."} + token
     3. Terminal exibe a saída linha a linha com colorização
═══════════════════════════════════════════════════════════════ */

(function () {
  const SERVER_PORT = 7510;
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
