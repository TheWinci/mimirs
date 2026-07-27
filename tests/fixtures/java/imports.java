package fixtures.imports;

import java.util.List;
import java.util.*;
import static java.util.Collections.emptyList;
import static java.util.Collections.*;

class Imports {
    List<String> values() {
        emptyList();
        singletonList("value");
        Set.of("value");
        return List.of();
    }
}
