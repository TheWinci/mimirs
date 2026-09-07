use crate::runner::run;

pub fn execute(run: impl Fn()) {
    run();

    let callback = helper;
    callback();

    {
        use crate::nested::run;
        run();
    }

    {
        late_run();
        use crate::late::late_run;
    }

    helper();
}

fn helper() {}
