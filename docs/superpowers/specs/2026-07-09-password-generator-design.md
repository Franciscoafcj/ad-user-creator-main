# Design: Gerador de Senha na Criação de Usuário

## 1. Objetivos e Requisitos
- **Geração Automática**: Gerar uma senha inicial inteligente dinamicamente enquanto o operador digita o Nome Completo.
- **Botão de Regeneração**: Adicionar um botão no input de senha para forçar a geração de uma nova senha a qualquer momento.
- **Regra de Formação**:
  - Pega o primeiro nome (ex: "Francisco de Assis" -> "Francisco").
  - Remove acentos e caracteres especiais.
  - Extrai as 4 primeiras letras do nome (se tiver menos de 4, pega o nome todo).
  - Formata como: Primeira letra em Maiúscula, demais em minúsculas (ex: "Fran").
  - Adiciona `@` e 4 dígitos numéricos aleatórios (ex: "Fran@8530").
- **Preservação de Edição**: Se o operador editar a senha manualmente, a geração automática pelo nome é desabilitada para evitar sobrescrever a digitação.

## 2. Interface (UI)
Modificações no campo de senha no arquivo `index.html`:
- O contêiner `.input-with-icon` receberá um botão adicional para gerar a senha.
- Estilização do botão em `style.css` para se alinhar aos demais botões de ícone existentes.

```html
<div class="input-with-icon">
  <input type="password" id="password" placeholder="Senha temporária" />
  <button type="button" class="generate-pw" id="generatePw" title="Gerar senha aleatória">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <!-- Ícone de chave -->
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  </button>
  <button type="button" class="toggle-pw" id="togglePw" title="Mostrar/ocultar senha">
    ...
  </button>
</div>
```

## 3. Lógica do Frontend (`app.js`)
- Criar a função `generatePasswordFromName(fullName)` que aplica a higienização de string e gera a senha.
- Adicionar uma flag de controle `passwordManuallyEdited` para detectar se o operador digitou a senha manualmente.
- Adicionar escutas de evento:
  - Input em `#fullName`: se a senha estiver vazia ou gerada de forma automática, atualizar o campo de senha.
  - Clique em `#generatePw`: gerar uma nova senha ignorando o estado de edição manual e resetar a flag `passwordManuallyEdited = false`.
  - Input em `#password`: se disparado pelo operador, definir `passwordManuallyEdited = true`.

## 4. Validação e Testes
- Validar se nomes com acentos (ex: `João`) são higienizados corretamente para `Joao@1234`.
- Validar se nomes curtos (ex: `Ana`) geram senhas no formato `Ana@1234`.
- Validar se a força da senha é recalculada após a geração automática.
