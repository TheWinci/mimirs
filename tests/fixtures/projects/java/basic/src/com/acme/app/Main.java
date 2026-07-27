package com.acme.app;

import com.acme.model.*;
import com.acme.tools.Worker;
import static com.acme.tools.Tools.run;
import static com.acme.tools.Tools.*;

class Main {
    void launch() {
        Local.start();
        Worker.start();
        run();
        missingFromWildcard();
        Model.create();
        new Worker();
        System.out.println("done");
    }
}
