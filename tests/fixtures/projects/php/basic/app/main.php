<?php
namespace App;

use Project\Service\Worker;
use function Project\Helpers\run as execute;

require "../bootstrap.php";

Worker::start();
new Worker();
execute();
Local::start();
bootstrap();
Worker::missing();
