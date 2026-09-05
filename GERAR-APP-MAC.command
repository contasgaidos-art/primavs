#!/bin/bash
cd "$(dirname "$0")"
echo "=================================================="
echo "   PRISMA Virtual Sound - Gerar app do Mac"
echo "=================================================="
echo ""
echo "(1/2) Instalando ferramentas (so na 1a vez, pode demorar)..."
npm install || { echo ""; echo "ERRO no npm install. Tem o Node.js instalado? https://nodejs.org"; read -p "Enter para sair"; exit 1; }
echo ""
echo "(2/2) Gerando o app... aguarde."
npm run dist:mac || { echo ""; echo "ERRO ao gerar. Tire um print e mande para o suporte."; read -p "Enter para sair"; exit 1; }
echo ""
echo "=================================================="
echo "   PRONTO! O app (.dmg) esta na pasta 'dist'."
echo "=================================================="
open dist
read -p "Enter para fechar"
