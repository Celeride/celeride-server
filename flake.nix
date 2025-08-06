{
  description = "ImagineWorks Bus Tracking Development Environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_20
            pnpm
            nodePackages.pnpm
            git
          ];

          shellHook = ''
            echo "ImagineWorks Bus Tracking Development Environment"
            echo "Node.js version: $(node --version)"
            echo "npm version: $(npm --version)"
            echo ""
            echo "To get started:"
            echo "  npm init -y"
            echo "  npm install express socket.io cors dotenv axios"
            echo "  echo 'PERPLEXITY_API_KEY=your_key_here' > .env"
            echo "  echo 'PORT=3000' >> .env"
            echo "  node server.js"
          '';
        };
      });
}
