<?php
namespace First;

use Vendor\FirstTool as Tool;
function first(): void { Tool::run(); }

namespace Second;

use Vendor\SecondTool as Tool;
function second(): void { Tool::run(); }

namespace Third {
    use Vendor\ThirdTool as Tool;
    function third(): void { Tool::run(); }
}

namespace {
    function fallback(): void { finish(); }
}
