<?php
namespace Fixtures\Imports;

use Vendor\Package\Client;
use Vendor\Package\Service as WorkerService;
use Vendor\Package\{Helper, Formatter as TextFormatter};
use function Vendor\helpers\run;
use function Vendor\helpers\{start, stop as halt};
use const Vendor\VERSION;
use const Vendor\flags\{ENABLED, DISABLED as OFF};
use Vendor\Mixed\{Thing, function execute as exec, const FLAG};

require "bootstrap.php";
require_once("config.php");
include "helpers.php";
include_once("optional.php");
require_once __DIR__ . "/vendor.php";
include($path);
